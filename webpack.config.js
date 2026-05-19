// @ts-check
'use strict';

const path = require('path');

/** @type {import('webpack').Configuration} */
const clientConfig = {
    context: path.resolve(__dirname, 'client'),
    entry: './src/extension.ts',
    target: 'node',
    mode: 'none',
    output: {
        path: path.resolve(__dirname, 'client', 'dist'),
        filename: 'extension.js',
        libraryTarget: 'commonjs2',
    },
    resolve: {
        extensions: ['.ts', '.js'],
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                exclude: /node_modules/,
                use: [
                    {
                        loader: 'ts-loader',
                        options: {
                            configFile: path.resolve(__dirname, 'client', 'tsconfig.json'),
                            transpileOnly: true,
                            compilerOptions: {
                                composite: false,
                                declaration: false,
                                declarationMap: false,
                            },
                        },
                    },
                ],
            },
        ],
    },
    externals: {
        vscode: 'commonjs vscode',
    },
    devtool: 'source-map',
    infrastructureLogging: { level: 'log' },
};

/** @type {import('webpack').Configuration} */
const serverConfig = {
    context: path.resolve(__dirname, 'server'),
    entry: './src/server.ts',
    target: 'node',
    mode: 'none',
    output: {
        path: path.resolve(__dirname, 'server', 'dist'),
        filename: 'server.js',
        libraryTarget: 'commonjs2',
    },
    resolve: {
        extensions: ['.ts', '.js'],
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                exclude: /node_modules/,
                use: [
                    {
                        loader: 'ts-loader',
                        options: {
                            configFile: path.resolve(__dirname, 'server', 'tsconfig.json'),
                            transpileOnly: true,
                            compilerOptions: {
                                composite: false,
                                declaration: false,
                                declarationMap: false,
                            },
                        },
                    },
                ],
            },
        ],
    },
    devtool: 'source-map',
    infrastructureLogging: { level: 'log' },
};

module.exports = [clientConfig, serverConfig];
