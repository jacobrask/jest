/**
 * Copyright (c) 2014-present, Facebook, Inc. All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @flow
 */

import type {Argv} from 'types/Argv';
import type {Context} from 'types/Context';
import type {GlobalConfig} from 'types/Config';
import type {TestSelectionConfig} from './SearchSource';
import type {AggregatedResult} from 'types/TestResult';
import type TestWatcher from './TestWatcher';

import path from 'path';
import {Console, formatTestResults} from 'jest-util';
import chalk from 'chalk';
import fs from 'graceful-fs';
import getMaxWorkers from './lib/getMaxWorkers';
import getTestPathPattern from './lib/getTestPathPattern';
import SearchSource from './SearchSource';
import updateArgv from './lib/updateArgv';
import TestRunner from './TestRunner';
import TestSequencer from './TestSequencer';
import {makeEmptyAggregatedTestResult} from './testResultHelpers';

const setConfig = (contexts, newConfig) =>
  contexts.forEach(
    context =>
      (context.config = Object.freeze(
        Object.assign({}, context.config, newConfig),
      )),
  );

const formatTestPathPattern = pattern => {
  const testPattern = pattern.testPathPattern;
  const input = pattern.input;
  const formattedPattern = `/${testPattern || ''}/`;
  const formattedInput = pattern.shouldTreatInputAsPattern
    ? `/${input || ''}/`
    : `"${input || ''}"`;
  return input === testPattern ? formattedInput : formattedPattern;
};

const getNoTestsFoundMessage = (testRunData, pattern) => {
  if (pattern.onlyChanged) {
    return (
      chalk.bold(
        'No tests found related to files changed since last commit.\n',
      ) +
      chalk.dim(
        pattern.watch
          ? 'Press `a` to run all tests, or run Jest with `--watchAll`.'
          : 'Run Jest without `-o` to run all tests.',
      )
    );
  }

  const pluralize = (word: string, count: number, ending: string) =>
    `${count} ${word}${count === 1 ? '' : ending}`;
  const testPathPattern = formatTestPathPattern(pattern);
  const individualResults = testRunData.map(testRun => {
    const stats = testRun.matches.stats || {};
    const config = testRun.context.config;
    const statsMessage = Object.keys(stats)
      .map(key => {
        if (key === 'roots' && config.roots.length === 1) {
          return null;
        }
        const value = config[key];
        if (value) {
          const matches = pluralize('match', stats[key], 'es');
          return `  ${key}: ${chalk.yellow(value)} - ${matches}`;
        }
        return null;
      })
      .filter(line => line)
      .join('\n');

    return testRun.matches.total
      ? `In ${chalk.bold(config.rootDir)}\n` +
          `  ${pluralize('file', testRun.matches.total || 0, 's')} checked.\n` +
          statsMessage
      : `No files found in ${config.rootDir}.\n` +
          `Make sure Jest's configuration does not exclude this directory.` +
          `\nTo set up Jest, make sure a package.json file exists.\n` +
          `Jest Documentation: ` +
          `facebook.github.io/jest/docs/configuration.html`;
  });
  return (
    chalk.bold('No tests found') +
    '\n' +
    individualResults.join('\n') +
    '\n' +
    `Pattern: ${chalk.yellow(testPathPattern)} - 0 matches`
  );
};

const getTestPaths = async (
  globalConfig,
  context,
  pattern,
  argv,
  outputStream,
) => {
  const source = new SearchSource(context);
  let data = await source.getTestPaths(pattern);
  if (!data.tests.length) {
    if (pattern.onlyChanged && data.noSCM) {
      if (globalConfig.watch) {
        // Run all the tests
        updateArgv(argv, 'watchAll', {noSCM: true});
        pattern = getTestPathPattern(argv);
        data = await source.getTestPaths(pattern);
      } else {
        new Console(outputStream, outputStream).log(
          'Jest can only find uncommitted changed files in a git or hg ' +
            'repository. If you make your project a git or hg ' +
            'repository (`git init` or `hg init`), Jest will be able ' +
            'to only run tests related to files changed since the last ' +
            'commit.',
        );
      }
    }
  }
  return data;
};

const processResults = (runResults, options) => {
  if (options.testResultsProcessor) {
    /* $FlowFixMe */
    runResults = require(options.testResultsProcessor)(runResults);
  }
  if (options.isJSON) {
    if (options.outputFile) {
      const outputFile = path.resolve(process.cwd(), options.outputFile);

      fs.writeFileSync(
        outputFile,
        JSON.stringify(formatTestResults(runResults)),
      );
      process.stdout.write(
        `Test results written to: ` +
          `${path.relative(process.cwd(), outputFile)}\n`,
      );
    } else {
      process.stdout.write(JSON.stringify(formatTestResults(runResults)));
    }
  }
  return options.onComplete && options.onComplete(runResults);
};

const runJest = async (
  globalConfig: GlobalConfig,
  contexts: Array<Context>,
  argv: Argv,
  outputStream: stream$Writable | tty$WriteStream,
  testWatcher: TestWatcher,
  startRun: () => *,
  onComplete: (testResults: AggregatedResult) => any,
  // We use this internaly at FB. Since we run multiple processes and most
  // of them don't match any tests, we don't want to print 'no tests found'
  // message for all of them.
  // This will no longer be needed when we complete this:
  // https://github.com/facebook/jest/issues/3768
  printNoTestsMessage?: (
    outputStream: stream$Writable,
    testRunData: Array<*>,
    testSelectionConfig: TestSelectionConfig,
  ) => void,
) => {
  const maxWorkers = getMaxWorkers(argv);
  const testSelectionConfig = getTestPathPattern(argv);
  const sequencer = new TestSequencer();
  let allTests = [];
  const testRunData = await Promise.all(
    contexts.map(async context => {
      const matches = await getTestPaths(
        globalConfig,
        context,
        testSelectionConfig,
        argv,
        outputStream,
      );
      allTests = allTests.concat(matches.tests);
      return {context, matches};
    }),
  );

  allTests = sequencer.sort(allTests);

  if (argv.listTests) {
    console.log(JSON.stringify(allTests.map(test => test.path)));
    onComplete && onComplete(makeEmptyAggregatedTestResult());
    return null;
  }

  if (!allTests.length) {
    if (printNoTestsMessage) {
      printNoTestsMessage(outputStream, testRunData, testSelectionConfig);
    } else {
      new Console(outputStream, outputStream).log(
        getNoTestsFoundMessage(testRunData, testSelectionConfig),
      );
    }
  } else if (
    allTests.length === 1 &&
    globalConfig.silent !== true &&
    globalConfig.verbose !== false
  ) {
    // $FlowFixMe
    globalConfig = Object.freeze(
      Object.assign({}, globalConfig, {verbose: true}),
    );
  }

  // When using more than one context, make all printed paths relative to the
  // current cwd. rootDir is only used as a token during normalization and
  // has no special meaning afterwards except for printing information to the
  // CLI.
  setConfig(contexts, {rootDir: process.cwd()});

  const results = await new TestRunner(globalConfig, {
    maxWorkers,
    pattern: testSelectionConfig,
    startRun,
    testNamePattern: argv.testNamePattern,
    testPathPattern: formatTestPathPattern(testSelectionConfig),
  }).runTests(allTests, testWatcher);

  sequencer.cacheResults(allTests, results);

  return processResults(results, {
    isJSON: argv.json,
    onComplete,
    outputFile: argv.outputFile,
    testResultsProcessor: globalConfig.testResultsProcessor,
  });
};

module.exports = runJest;
