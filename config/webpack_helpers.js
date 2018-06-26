/**
 * @license
 * Copyright 2016 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const ExtractTextPlugin = require('extract-text-webpack-plugin');
const webpack = require('webpack');
const ClosureCompilerPlugin = require('webpack-closure-compiler');
const fs = require('fs');
const AliasPlugin = require('./webpack_alias_plugin');
const resolveReal = require('./resolve_real');

// Note: We use require.resolve below to ensure the plugins are resolved
// relative to this configuration file, rather than relative to the source
// files, in case this configuration is being used from a dependent project that
// doesn't have all of these plugins as direct dependencies.
//
// require.resolve resolves all symlinks.
const DEFAULT_BABEL_PLUGINS = exports.DEFAULT_BABEL_PLUGINS = [];

const minifyBabelPlugins = exports.minifyBabelPlugins = [
  // Google Closure Compiler doesn't accept the:
  //
  //   class X extends __WEBPACK_IMPORTED_MODULE_5_utils__["a"]
  //
  // syntax generated by webpack 2.  Converting ES6 classes to regular constructor functions works
  // around this problem.
  require.resolve('babel-plugin-transform-es2015-classes'),
];

const DEFAULT_DATA_SOURCES = exports.DEFAULT_DATA_SOURCES = [
  {
    source: 'neuroglancer/datasource/brainmaps',
    registerCredentials: 'neuroglancer/datasource/brainmaps/register_credentials_provider'
  },
  'neuroglancer/datasource/ndstore',
  'neuroglancer/datasource/dvid',
  'neuroglancer/datasource/render',
  'neuroglancer/datasource/openconnectome',
  'neuroglancer/datasource/precomputed',
  'neuroglancer/datasource/nifti',
  {source: 'neuroglancer/datasource/vtk', register: null},
  {source: 'neuroglancer/datasource/csv', register: null},
];

const DEFAULT_SUPPORTED_LAYERS = exports.DEFAULT_SUPPORTED_LAYERS = [
  'neuroglancer/image_user_layer',
  'neuroglancer/vector_graphics_user_layer',
  'neuroglancer/segmentation_user_layer',
  'neuroglancer/single_mesh_user_layer',
  'neuroglancer/annotation/user_layer',
  // 'neuroglancer/synapse/user_layer',
];

/**
 * Returns a loader specification for TypeScript files.
 *
 * @param {boolean=} options.useBabel Use Babel.
 * @param {string[]=} options.babelPlugins Babel plugins to use in place of DEFAULT_BABEL_PLUGINS.
 */
function getTypescriptLoaderEntry(options) {
  if (options === undefined) {
    options = {};
  }
  const useBabel = options.useBabel !== undefined ? options.useBabel : true;
  const babelPlugins = options.babelPlugins !== undefined ?
      options.babelPlugins :
      (options.minify ? minifyBabelPlugins : DEFAULT_BABEL_PLUGINS);
  const babelConfig = {
    cacheDirectory: true,
    plugins: babelPlugins,
  };

  let loaders = [];

  let tsLoaderPrefix = '';
  if (useBabel) {
    loaders.push({loader: 'babel-loader', options: babelConfig});
  }

  let tsconfigPath = options.tsconfigPath || resolveReal(__dirname, '../tsconfig.json');
  let tsconfig = require(tsconfigPath);
  let extraResolveAliases = {};
  let newCompilerPaths = {};
  if (tsconfig.compilerOptions && tsconfig.compilerOptions.paths) {
    for (let key of Object.keys(tsconfig.compilerOptions.paths)) {
      let value = tsconfig.compilerOptions.paths[key];
      newCompilerPaths[key] = value;
      if (!key.endsWith('/*') || !Array.isArray(value) || value.length !== 1 ||
          !value[0].endsWith('/*')) {
        // Silently skip.
        console.log(`Skipping ${JSON.stringify(key)} -> ${JSON.stringify(value)}`);
        continue;
      }
      const resolvedTarget =
          resolveReal(path.dirname(tsconfigPath), value[0].substring(0, value[0].length - 2));
      extraResolveAliases[key.substring(0, key.length - 2)] = resolvedTarget;
      newCompilerPaths[key] = [resolvedTarget + '/*'];
    }
  }
  let tsOptions = {
    compiler: resolveReal(__dirname, 'typescript_compiler_shim.js'),
    configFile: tsconfigPath,
    compilerOptions: {paths: newCompilerPaths},
    instance: 'main',
  };
  loaders.push({loader: 'ts-loader', options: tsOptions});
  return {loaderEntry: {test: /\.ts$/, loader: loaders}, extraResolveAliases};
}

/**
 * Returns a base webpack configuration.
 *
 * @param {object} options In addition to the options of getTypescriptLoaderEntry, the following
 *     options are also valid.
 * @param {string=} options.tsconfigPath Alternative path to tsconfig.json to use, e.g. in order to
 *     specify additional path aliases.  Any path aliases specified in tsconfig will automatically
 * be added as webpack resolve aliases.
 * @param {Object.<string,string>} options.resolveAliases Additional module aliases for webpack.
 * @param {Object.<string,string>} options.resolveLoaderAliases Additional loader aliases for
 * webpack.
 * @param {string[]} options.resolveLoaderRoots Additional root directories for finding webpack
 *     loaders.  You may want to include the path to the 'node_modules' directory of your project.
 * @param {boolean=} options.noOutput If true, no output section is added to the configuration.
 * @param {string=} options.output Specifies the directory where output will be generated.  Must be
 *     specified unless noOutput === true.
 */
function getBaseConfig(options) {
  options = options || {};
  let {loaderEntry: tsLoaderEntry, extraResolveAliases} = getTypescriptLoaderEntry(options);
  console.log(extraResolveAliases);
  let aliasMappings = Object.assign(
      {
        'neuroglancer-testdata': resolveReal(__dirname, '../testdata'),

        // Patched version of jpgjs.
        'jpgjs': resolveReal(__dirname, '../third_party/jpgjs/jpg.js'),
      },
      extraResolveAliases, options.resolveAliases || {});
  let baseConfig = {
    resolve: {
      extensions: ['.ts', '.js'],
      /**
       * Don't use the built-in alias mechanism because of a bug in the normalize function defined
       * in the memory-fs package it depends on.
       */
      // alias: aliasMappings,
      plugins: [
        new AliasPlugin(aliasMappings, 'described-resolve', 'resolve'),
      ],
    },
    resolveLoader: {
      alias: Object.assign(
          {
            'raw-data$': resolveReal(__dirname, 'raw-data-loader.js'),
          },
          options.resolveLoaderAliases || []),
      modules: [
        ...(options.resolveLoaderRoots || []),
        ...(fs.existsSync(path.join(__dirname, '../node_modules')) ?
                [resolveReal(__dirname, '../node_modules')] :
                []),
      ],
    },
    devtool: 'source-map',
    module: {
      rules: [
        tsLoaderEntry, {test: /\.json$/, loader: require.resolve('json-loader')}, {
          test: /\.css$/,
          loader: ExtractTextPlugin.extract({fallback: 'style-loader', use: 'css-loader'})
        },
        {
          test: /\.glsl$/,
          loader: [
            {loader: require.resolve('raw-loader')},
            {loader: require.resolve('glsl-strip-comments-loader')},
          ],
        }
      ],
    },
    node: {'Buffer': false},
  };
  if (!options.noOutput) {
    if (options.outputPath === undefined) {
      throw new Error('options.outputPath must be specified.');
    }
    baseConfig.output = {filename: '[name].bundle.js', path: options.outputPath, sourcePrefix: ''};
  }
  return baseConfig;
}

/**
 * Returns an array containing the webpack configuration objects for the main and worker bundles.
 *
 * @param {object} options Configuration options.  In addition to the options of getBaseConfig and
 *     getTypescriptLoaderEntry, the following options may also be specified.
 * @param {boolean=} [options.minify=false] Specifies whether to produce minified output (using the
 *     SIMPLE mode of Google Closure Compiler).
 * @param {boolean=} [options.python=false] Specifies whether to use the Python client
 *     configuration.
 * @param {boolean=} [options.registerCredentials=!options.python] Specifies whether to register
 *     source-specific CredentialsProvider implementations with the default credentials manager.
 * @param {function(object)=} options.modifyBaseConfig Function that is invoked on the result of
 *     getBaseConfig, and is allowed to modify it before it is used to generate the main and worker
 *     bundles.
 * @param {Object.<string,string>=} options.defines Additional defines to pass to
 *     webpack.DefinePlugin.  You can use this to override the BRAINMAPS_CLIENT_ID, for example.  To
 *     insert a string literal, be sure to JSON.stringify.
 * @param {string[]} [options.dataSources=DEFAULT_DATA_SOURCES] Array of data source to include,
 *     specified as directories containing a 'frontend.ts' and 'backend.ts' file to be included in
 *     the frontend and backend bundles, respectively.  Note that if you wish for the default data
 *     sources to be included, you must include them in the array that you pass.
 * @param {string[]} [options.extraDataSources=[]] Array of additional data source to include.
 * @param {string[]=} options.chunkWorkerModules Array of additional modules to include in the chunk
 *     worker.
 * @param {object[]=} options.commonPlugins Array of additional plugins to include in both the main
 *     and worker configurations.
 * @param {object[]=} options.chunkWorkerPlugins Array of additional plugins to include in the
 *     worker configuration.
 * @param {object[]=} options.frontendPlugins Array of additional plugins to include in the main
 *     configuration.
 * @param {string[]=} options.frontendModules Array of modules to include in the frontend bundle.
 *     If specified, '../src/main.ts' will not be included automatically.
 * @param {string[]=} [options.supportedLayers=DEFAULT_SUPPORTED_LAYERS] Array of supported layer
 *     modules to include in the frontend.
 * @param options.cssPlugin If specified, overrides the default CSS plugin for the frontend.
 * @param options.htmlPlugin If specified, overrides the default HTML plugin for the frontend.
 */
function getViewerConfig(options) {
  options = options || {};
  let minify = options.minify;
  let baseConfig = getBaseConfig(options);
  if (options.modifyBaseConfig) {
    options.modifyBaseConfig(baseConfig);
  }
  let dataSources = [...(options.dataSources || DEFAULT_DATA_SOURCES),
                     ...(options.extraDataSources || [])];
  let supportedLayers = options.supportedLayers || DEFAULT_SUPPORTED_LAYERS;
  let frontendDataSourceModules = [];
  let backendDataSourceModules = [];
  const registerCredentials =
      options.registerCredentials !== undefined ? options.registerCredentials : !options.python;
  for (let datasource of dataSources) {
    if (typeof datasource === 'string') {
      datasource = {source: datasource};
    }
    if (datasource.frontend !== null) {
      frontendDataSourceModules.push(datasource.frontend || `${datasource.source}/frontend`);
    }
    if (registerCredentials && datasource.registerCredentials) {
      frontendDataSourceModules.push(datasource.registerCredentials);
    }
    if (datasource.register === undefined) {
      frontendDataSourceModules.push(`${datasource.source}/register_default`);
    } else if (datasource.register !== null) {
      frontendDataSourceModules.push(datasource.register);
    }
    if (datasource.backend !== null) {
      backendDataSourceModules.push(datasource.backend || `${datasource.source}/backend`);
    }
  }
  let defaultDefines = {
    // This is the default client ID used for the hosted neuroglancer.
    // In addition to the hosted neuroglancer origin, it is valid for
    // the origins:
    //
    //   localhost:8000
    //   127.0.0.1:8000
    //   localhost:8080
    //   127.0.0.1:8080
    //
    // To deploy to a different origin, you will need to generate your
    // own client ID from on the Google Developer Console and substitute
    // it in.
    'BRAINMAPS_CLIENT_ID':
        JSON.stringify('639403125587-4k5hgdfumtrvur8v48e3pr7oo91d765k.apps.googleusercontent.com'),
  };
  let extraDefines = options.defines || {};
  let srcDir = resolveReal(__dirname, '../src');
  let commonPlugins = [];
  if (minify) {
    commonPlugins.push(new ClosureCompilerPlugin({
      compiler: {
        language_in: 'ECMASCRIPT6',
        language_out: 'ECMASCRIPT5',
        compilation_level: 'SIMPLE',
      },
      concurrency: 3,
    }));
  }
  let extraChunkWorkerModules = options.chunkWorkerModules || [];
  let extraCommonPlugins = options.commonPlugins || [];
  let extraFrontendPlugins = options.frontendPlugins || [];
  let extraChunkWorkerPlugins = options.chunkWorkerPlugins || [];
  let chunkWorkerModules = [
    'neuroglancer/worker_rpc_context',
    'neuroglancer/chunk_manager/backend',
    'neuroglancer/chunked_graph/backend',
    'neuroglancer/sliceview/backend',
    'neuroglancer/perspective_view/backend',
    'neuroglancer/annotation/backend',
    ...backendDataSourceModules,
    ...extraChunkWorkerModules,
  ];
  let frontendModules = options.frontendModules || [resolveReal(srcDir, 'main.ts')];
  let frontendLayerModules = [];
  for (let name of supportedLayers) {
    frontendLayerModules.push(name);
  }
  let htmlPlugin =
      options.htmlPlugin || new HtmlWebpackPlugin({template: resolveReal(srcDir, 'index.html')});
  let cssPlugin =
      options.cssPlugin || new ExtractTextPlugin({filename: 'styles.css', allChunks: true});
  return [
    Object.assign(
        {
          entry:
              {'main': [...frontendDataSourceModules, ...frontendLayerModules, ...frontendModules]},
          target: 'web',
          plugins: [
            htmlPlugin,
            cssPlugin,
            new webpack.DefinePlugin(Object.assign({}, defaultDefines, extraDefines)),
            ...extraFrontendPlugins,
            ...commonPlugins,
            ...extraCommonPlugins,
          ],
        },
        baseConfig),
    Object.assign(
        {
          entry: {'chunk_worker': [...chunkWorkerModules]},
          target: 'webworker',
          plugins: [
            new webpack.DefinePlugin(
                Object.assign({}, defaultDefines, extraDefines)),
            ...extraChunkWorkerPlugins,
            ...commonPlugins,
            ...extraCommonPlugins,
          ],
        },
        baseConfig),
  ];
}


function makePythonClientOptions(options) {
  const srcDir = resolveReal(__dirname, '../src');
  options = Object.assign({}, options);
  options.extraDataSources = [...(options.extraDataSources || []),
                              {source: 'neuroglancer/datasource/python', register: null},
                             ];
  options.frontendModules = options.frontendModules || [resolveReal(srcDir, 'main_python.ts')];
  options.registerCredentials = false;
  return options;
}

function getViewerConfigFromEnv(options, env) {
  env = env || 'dev';
  const envParts = new Set(env.split('-'));
  options = Object.assign({}, options);
  if (envParts.has('min')) {
    options.minify = true;
  }
  if (envParts.has('python')) {
    options = makePythonClientOptions(options);
  }
  return getViewerConfig(options);
}

exports.getTypescriptLoaderEntry = getTypescriptLoaderEntry;
exports.getBaseConfig = getBaseConfig;
exports.getViewerConfig = getViewerConfig;
exports.makePythonClientOptions = makePythonClientOptions;
exports.getViewerConfigFromEnv = getViewerConfigFromEnv;
