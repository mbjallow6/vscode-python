// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import { inject, injectable } from 'inversify';
import { Event, EventEmitter } from 'vscode';
import { CancellationToken } from 'vscode-jsonrpc';
import { createPromiseFromCancellation } from '../../../common/cancellation';
import '../../../common/extensions';
import { IInterpreterService, PythonInterpreter } from '../../../interpreter/contracts';
import { sendTelemetryEvent } from '../../../telemetry';
import { Telemetry } from '../../constants';
import {
    JupyterInterpreterDependencyResponse,
    JupyterInterpreterDependencyService
} from './jupyterInterpreterDependencyService';
import { JupyterInterpreterOldCacheStateStore } from './jupyterInterpreterOldCacheStateStore';
import { JupyterInterpreterSelector } from './jupyterInterpreterSelector';
import { JupyterInterpreterStateStore } from './jupyterInterpreterStateStore';

@injectable()
export class JupyterInterpreterService {
    private _selectedInterpreter?: PythonInterpreter;
    private _selectedInterpreterPath?: string;
    private _onDidChangeInterpreter = new EventEmitter<PythonInterpreter>();
    public get onDidChangeInterpreter(): Event<PythonInterpreter> {
        return this._onDidChangeInterpreter.event;
    }

    constructor(
        @inject(JupyterInterpreterOldCacheStateStore)
        private readonly oldVersionCacheStateStore: JupyterInterpreterOldCacheStateStore,
        @inject(JupyterInterpreterStateStore) private readonly interpreterSelectionState: JupyterInterpreterStateStore,
        @inject(JupyterInterpreterSelector) private readonly jupyterInterpreterSelector: JupyterInterpreterSelector,
        @inject(JupyterInterpreterDependencyService)
        private readonly interpreterConfiguration: JupyterInterpreterDependencyService,
        @inject(IInterpreterService) private readonly interpreterService: IInterpreterService
    ) {}
    /**
     * Gets the selected interpreter configured to run Jupyter.
     *
     * @param {CancellationToken} [token]
     * @returns {(Promise<PythonInterpreter | undefined>)}
     * @memberof JupyterInterpreterService
     */
    public async getSelectedInterpreter(token?: CancellationToken): Promise<PythonInterpreter | undefined> {
        if (this._selectedInterpreter) {
            return this._selectedInterpreter;
        }

        const resolveToUndefinedWhenCancelled = createPromiseFromCancellation({
            cancelAction: 'resolve',
            defaultValue: undefined,
            token
        });
        // For backwards compatiblity check if we have a cached interpreter (older version of extension).
        // If that interpreter has everything we need then use that.
        let interpreter = await Promise.race([
            this.getInterpreterFromChangeOfOlderVersionOfExtension(),
            resolveToUndefinedWhenCancelled
        ]);
        if (interpreter) {
            return interpreter;
        }

        const pythonPath = this._selectedInterpreterPath || this.interpreterSelectionState.selectedPythonPath;
        if (!pythonPath) {
            // Check if current interpreter has all of the required dependencies.
            // If yes, then use that.
            interpreter = await this.interpreterService.getActiveInterpreter(undefined);
            if (!interpreter) {
                return;
            }
            // Use this interpreter going forward.
            if (await this.interpreterConfiguration.areDependenciesInstalled(interpreter)) {
                this.setAsSelectedInterpreter(interpreter);
                return interpreter;
            }
            return;
        }

        const interpreterDetails = await Promise.race([
            this.interpreterService.getInterpreterDetails(pythonPath, undefined),
            resolveToUndefinedWhenCancelled
        ]);
        if (interpreterDetails) {
            this._selectedInterpreter = interpreterDetails;
        }
        return interpreterDetails;
    }
    /**
     * Selects and interpreter to run jupyter server.
     * Validates and configures the interpreter.
     * Once completed, the interpreter is stored in settings, else user can select another interpreter.
     *
     * @param {CancellationToken} [token]
     * @returns {(Promise<PythonInterpreter | undefined>)}
     * @memberof JupyterInterpreterService
     */
    public async selectInterpreter(token?: CancellationToken): Promise<PythonInterpreter | undefined> {
        const resolveToUndefinedWhenCancelled = createPromiseFromCancellation({
            cancelAction: 'resolve',
            defaultValue: undefined,
            token
        });
        const interpreter = await Promise.race([
            this.jupyterInterpreterSelector.selectInterpreter(),
            resolveToUndefinedWhenCancelled
        ]);
        if (!interpreter) {
            sendTelemetryEvent(Telemetry.SelectJupyterInterpreter, undefined, { result: 'notSelected' });
            return;
        }

        const result = await this.interpreterConfiguration.installMissingDependencies(interpreter, undefined, token);
        switch (result) {
            case JupyterInterpreterDependencyResponse.ok: {
                this.setAsSelectedInterpreter(interpreter);
                return interpreter;
            }
            case JupyterInterpreterDependencyResponse.cancel:
                sendTelemetryEvent(Telemetry.SelectJupyterInterpreter, undefined, { result: 'installationCancelled' });
                return;
            default:
                return this.selectInterpreter(token);
        }
    }
    private async getInterpreterFromChangeOfOlderVersionOfExtension(): Promise<PythonInterpreter | undefined> {
        const pythonPath = this.oldVersionCacheStateStore.getCachedInterpreterPath();
        if (!pythonPath) {
            return;
        }
        try {
            const interpreter = await this.interpreterService.getInterpreterDetails(pythonPath, undefined);
            if (!interpreter) {
                return;
            }
            if (await this.interpreterConfiguration.areDependenciesInstalled(interpreter)) {
                this.setAsSelectedInterpreter(interpreter);
                return interpreter;
            }
            // If dependencies are not installed, then ignore it. lets continue with the current logic.
        } finally {
            // Don't perform this check again, just clear the cache.
            this.oldVersionCacheStateStore.clearCache().ignoreErrors();
        }
    }
    private setAsSelectedInterpreter(interpreter: PythonInterpreter): void {
        this._selectedInterpreter = interpreter;
        this._onDidChangeInterpreter.fire(interpreter);
        this.interpreterSelectionState.updateSelectedPythonPath((this._selectedInterpreterPath = interpreter.path));
        sendTelemetryEvent(Telemetry.SelectJupyterInterpreter, undefined, { result: 'selected' });
    }
}
