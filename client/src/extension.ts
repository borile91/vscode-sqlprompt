import * as path from 'path';
import { workspace, ExtensionContext, commands, window } from 'vscode';

import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind
} from 'vscode-languageclient/node';

let client: LanguageClient | undefined;

export async function activate(context: ExtensionContext) {
  console.log('SQL Prompt: extension activating...');

  const serverModule = context.asAbsolutePath(
    path.join('server', 'out', 'server.js')
  );

  const debugOptions = { execArgv: ['--nolazy', '--inspect=6009'] };

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: debugOptions
    }
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'sql' },
      { scheme: 'untitled', language: 'sql' }
    ],
    synchronize: {
      configurationSection: 'sqlPrompt'
    }
  };

  client = new LanguageClient(
    'sqlPrompt',
    'SQL Prompt Language Server',
    serverOptions,
    clientOptions
  );

  // Register commands
  context.subscriptions.push(
    commands.registerCommand('sqlPrompt.connect', async () => {
      const config = workspace.getConfiguration('sqlPrompt');
      const connection = config.get<any>('connection');

      if (!connection || !connection.server) {
        const server = await window.showInputBox({
          prompt: 'SQL Server hostname',
          value: 'localhost'
        });
        if (!server) return;

        const database = await window.showInputBox({
          prompt: 'Database name',
          value: 'master'
        });
        if (!database) return;

        const user = await window.showInputBox({
          prompt: 'Username (leave empty for Windows Auth)',
          value: ''
        });

        let password = '';
        if (user) {
          password = await window.showInputBox({
            prompt: 'Password',
            password: true
          }) || '';
        }

        await config.update('connection', {
          server,
          database,
          user,
          password,
          port: 1433,
          trustServerCertificate: true
        }, true);
      }

      // Send connect request to server
      if (client) {
        await client.sendRequest('sqlPrompt/connect');
        window.showInformationMessage('SQL Prompt: Connected!');
      }
    }),

    commands.registerCommand('sqlPrompt.disconnect', async () => {
      if (client) {
        await client.sendRequest('sqlPrompt/disconnect');
        window.showInformationMessage('SQL Prompt: Disconnected.');
      }
    }),

    commands.registerCommand('sqlPrompt.reloadSchema', async () => {
      if (client) {
        await client.sendRequest('sqlPrompt/reloadSchema');
        window.showInformationMessage('SQL Prompt: Schema reloaded.');
      }
    })
  );

  await client.start();
  console.log('SQL Prompt: language server started.');
}

export async function deactivate() {
  if (client) {
    await client.stop();
    client = undefined;
  }
}
