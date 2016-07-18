/**
 * @license
 * Copyright (c) 2014 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
 */

"use strict";

const assert = require('chai').assert;
const path = require('path');

const hyd = require('../lib/analyzer');
const importParse = require('../lib/ast-utils/import-parse').importParse;

const FSUrlLoader = require('../lib/url-loader/fs-url-loader').FSUrlLoader;

let registry;

suite('importParse: HTML', () => {

  suite('parser returns expected ASTs', function() {
    let loader;

    setup(() => {
      loader = new FSUrlLoader(__dirname);
      return loader.load('/static/html-parse-target.html')
        .then((content) => {
          registry = importParse(content);
        });
    });

    test('find all templates', function() {
      assert.isDefined(registry.template, "The returned registry should find templates");
      assert.equal(registry.template.length, 3);
    });

    test('find all scripts', function() {
      assert.isDefined(registry.script, "The returned registry should find scripts");
      assert.equal(registry.script.length, 5);
    });

    test('find all imports', function() {
      assert.isDefined(registry.import, "The returned registry should find imports");
      assert.equal(registry.import.length, 1);
    });

    test('find all styles', function() {
      assert.isDefined(registry.style, "The returned registry should find styles");
      assert.equal(registry.style.length, 3);
    });
  });

  suite('malformed input is handled properly', function() {

    test('bad HTML reports a filename', () => {
      let loader = new FSUrlLoader(__dirname);
      let analyzer = new hyd.Analyzer({
        urlLoader: loader,
      });
      return analyzer.analyze("static/malformed.html").then((root) => {
        throw new Error("Should have thrown an error message.");
      }, (error) => {
        assert.include(error.message, "malformed.html");
      });
    });

  });

});
