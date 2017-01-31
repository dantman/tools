/**
 * @license
 * Copyright (c) 2014 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at
 * http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at
 * http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at
 * http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at
 * http://polymer.github.io/PATENTS.txt
 */
import * as path from 'path';
import * as urlLib from 'url';
const pathPosix = path.posix;
import * as dom5 from 'dom5';
import encodeString from './third_party/UglifyJS2/encode-string';

import * as parse5 from 'parse5';
import {ASTNode} from 'parse5';
import {Analyzer, Options as AnalyzerOptions} from 'polymer-analyzer';
import {Document, ScannedDocument} from 'polymer-analyzer/lib/model/document';
import {Import} from 'polymer-analyzer/lib/model/import';
import {ParsedHtmlDocument} from 'polymer-analyzer/lib/html/html-document';
import {FSUrlLoader} from 'polymer-analyzer/lib/url-loader/fs-url-loader';
import constants from './constants';
import * as astUtils from './ast-utils';
import * as matchers from './matchers';
import * as urlUtils from './url-utils';
import {Bundle, BundleStrategy, AssignedBundle, generateBundles, BundleUrlMapper, BundleManifest, sharedBundleUrlMapper, generateSharedDepsMergeStrategy} from './bundle-manifest';
import {BundledDocument, DocumentCollection} from './document-collection';
import {buildDepsIndex} from './deps-index';
import {UrlString} from './url-utils';

// TODO(usergenic): Want to figure out a way to get rid of the basePath param
// used in the inline functions, because it feels obnoxious to have to pass it
// around for an only-occasionally used case.

/**
 * Inline the contents of the html document returned by the link tag's href
 * at the location of the link tag and then remove the link tag.
 */
export async function inlineHtmlImport(
    basePath: UrlString|undefined,
    docUrl: UrlString,
    htmlImport: ASTNode,
    visitedUrls: Set<UrlString>,
    docBundle: AssignedBundle,
    manifest: BundleManifest,
    loader: (url: UrlString) => Promise<string>) {
  const rawImportUrl = dom5.getAttribute(htmlImport, 'href')!;
  const resolvedImportUrl = urlLib.resolve(docUrl, rawImportUrl);
  const importBundleUrl = manifest.bundleUrlForFile.get(resolvedImportUrl);

  // Don't reprocess the same file again.
  if (visitedUrls.has(resolvedImportUrl)) {
    astUtils.removeElementAndNewline(htmlImport);
    return;
  }

  // We've never seen this import before, so we'll add it to the set to guard
  // against processing it again in the future.
  visitedUrls.add(resolvedImportUrl);

  // If we can't find a bundle for the referenced import, record that we've
  // processed it, but don't remove the import link.  Browser will handle it.
  if (!importBundleUrl) {
    return;
  }

  // Don't inline an import into itself.
  if (docUrl === resolvedImportUrl) {
    astUtils.removeElementAndNewline(htmlImport);
    return;
  }

  // If we've previously visited a url that is part of a bundle, it means we've
  // handled that entire bundle, so we guard against inlining any other file
  // from that bundle by checking the visited urls for the bundle url itself.
  if (visitedUrls.has(importBundleUrl)) {
    astUtils.removeElementAndNewline(htmlImport);
    return;
  }

  // If the html import refers to a file which is bundled and has a different
  // url, then lets just rewrite the href to point to the bundle url.
  if (importBundleUrl !== docBundle.url) {
    const relative =
        urlUtils.relativeUrl(docUrl, importBundleUrl) || importBundleUrl;
    dom5.setAttribute(htmlImport, 'href', relative);
    visitedUrls.add(importBundleUrl);
    return;
  }

  const document =
      dom5.nodeWalkAncestors(htmlImport, (node) => !node.parentNode)!;
  const body = dom5.query(document, matchers.body)!;
  const importSource = await loader(resolvedImportUrl).catch(err => {
    throw new Error(`Unable to load ${resolvedImportUrl}: ${err.message}`);
  });

  // Is there a better way to get what we want other than using
  // parseFragment?
  const importDoc = parse5.parseFragment(importSource);
  rewriteImportedUrls(basePath, importDoc, resolvedImportUrl, docUrl);
  const nestedImports = dom5.queryAll(importDoc, matchers.htmlImport);

  // Move all of the import doc content after the html import.
  astUtils.insertAllBefore(
      htmlImport.parentNode!, htmlImport, importDoc.childNodes!);
  astUtils.removeElementAndNewline(htmlImport);

  // Recursively process the nested imports.
  for (const nestedImport of nestedImports) {
    await inlineHtmlImport(
        basePath,
        docUrl,
        nestedImport,
        visitedUrls,
        docBundle,
        manifest,
        loader);
  }
}

/**
 * Inlines the contents of the document returned by the script tag's src url
 * into the script tag content and removes the src attribute.
 */
export async function inlineScript(
    docUrl: UrlString,
    externalScript: ASTNode,
    loader: (url: UrlString) => Promise<string>) {
  const rawUrl = dom5.getAttribute(externalScript, 'src')!;
  const resolvedUrl = urlLib.resolve(docUrl, rawUrl);
  let script: string|undefined = undefined;
  try {
    script = await loader(resolvedUrl);
  } catch (err) {
    // If a script doesn't load, skip inlining.
    // TODO(usergenic): Add plylog logging for load error.
  }

  if (script === undefined) {
    return;
  }

  // Second argument 'true' tells encodeString to escape <script> tags.
  const scriptContent = encodeString(script, true);
  dom5.removeAttribute(externalScript, 'src');
  dom5.setTextContent(externalScript, scriptContent);
  return scriptContent;
}

/**
 * Inlines the contents of the stylesheet returned by the link tag's href url
 * into a style tag and removes the link tag.
 */
export async function inlineStylesheet(
    basePath: UrlString|undefined,
    docUrl: UrlString,
    cssLink: ASTNode,
    loader: (url: UrlString) => Promise<string>) {
  const stylesheetUrl = dom5.getAttribute(cssLink, 'href')!;
  const resolvedStylesheetUrl = urlLib.resolve(docUrl, stylesheetUrl);
  let stylesheetContent: string|undefined = undefined;
  try {
    stylesheetContent = await loader(resolvedStylesheetUrl);
  } catch (err) {
    // If a stylesheet doesn't load, skip inlining.
    // TODO(usergenic): Add plylog logging for load error.
  }

  if (stylesheetContent === undefined) {
    return;
  }

  const media = dom5.getAttribute(cssLink, 'media');
  const resolvedStylesheetContent = _rewriteImportedStyleTextUrls(
      basePath, resolvedStylesheetUrl, docUrl, stylesheetContent);
  const styleNode = dom5.constructors.element('style');

  if (media) {
    dom5.setAttribute(styleNode, 'media', media);
  }

  dom5.replace(cssLink, styleNode);
  dom5.setTextContent(styleNode, resolvedStylesheetContent);
  return styleNode;
}

/**
 * Walk through an import document, and rewrite all urls so they are
 * correctly relative to the main document url as they've been
 * imported from the import url.
 */
export function rewriteImportedUrls(
    basePath: UrlString|undefined,
    importDoc: ASTNode,
    importUrl: UrlString,
    mainDocUrl: UrlString) {
  _rewriteImportedElementAttrUrls(basePath, importDoc, importUrl, mainDocUrl);
  _rewriteImportedStyleUrls(basePath, importDoc, importUrl, mainDocUrl);
  _setImportedDomModuleAssetpaths(basePath, importDoc, importUrl, mainDocUrl);
}

/**
 * Find all element attributes which express urls and rewrite them so they
 * are correctly relative to the main document url as they've been
 * imported from the import url.
 */
function _rewriteImportedElementAttrUrls(
    basePath: UrlString|undefined,
    importDoc: ASTNode,
    importUrl: UrlString,
    mainDocUrl: UrlString) {
  const nodes = dom5.queryAll(importDoc, matchers.urlAttrs);
  for (const node of nodes) {
    for (const attr of constants.URL_ATTR) {
      const attrValue = dom5.getAttribute(node, attr);
      if (attrValue && !urlUtils.isTemplatedUrl(attrValue)) {
        let relUrl: UrlString;
        if (attr === 'style') {
          relUrl = _rewriteImportedStyleTextUrls(
              basePath, importUrl, mainDocUrl, attrValue);
        } else {
          relUrl = urlUtils.rewriteImportedRelPath(
              basePath, importUrl, mainDocUrl, attrValue);
          if (attr === 'assetpath' && relUrl.slice(-1) !== '/') {
            relUrl += '/';
          }
        }
        dom5.setAttribute(node, attr, relUrl);
      }
    }
  }
}

/**
 * Given a string of CSS, return a version where all occurrences of urls,
 * have been rewritten based on the relationship of the import url to the
 * main doc url.
 * TODO(usergenic): This is a static method that should probably be moved to
 * urlUtils or similar.
 */
function _rewriteImportedStyleTextUrls(
    basePath: UrlString|undefined,
    importUrl: UrlString,
    mainDocUrl: UrlString,
    cssText: string): string {
  return cssText.replace(constants.URL, match => {
    let path = match.replace(/["']/g, '').slice(4, -1);
    path =
        urlUtils.rewriteImportedRelPath(basePath, importUrl, mainDocUrl, path);
    return 'url("' + path + '")';
  });
}

/**
 * Find all urls in imported style nodes and rewrite them so they are now
 * correctly relative to the main document url as they've been imported from
 * the import url.
 */
function _rewriteImportedStyleUrls(
    basePath: UrlString|undefined,
    importDoc: ASTNode,
    importUrl: UrlString,
    mainDocUrl: UrlString) {
  const styleNodes = dom5.queryAll(
      importDoc,
      matchers.styleMatcher,
      undefined,
      dom5.childNodesIncludeTemplate);
  for (const node of styleNodes) {
    let styleText = dom5.getTextContent(node);
    styleText = _rewriteImportedStyleTextUrls(
        basePath, importUrl, mainDocUrl, styleText);
    dom5.setTextContent(node, styleText);
  }
}

/**
 * Set the assetpath attribute of all imported dom-modules which don't yet
 * have them.
 */
function _setImportedDomModuleAssetpaths(
    basePath: UrlString|undefined,
    importDoc: ASTNode,
    importUrl: UrlString,
    mainDocUrl: UrlString) {
  const domModules =
      dom5.queryAll(importDoc, matchers.domModuleWithoutAssetpath);
  for (let i = 0, node: ASTNode; i < domModules.length; i++) {
    node = domModules[i];
    let assetPathUrl =
        urlUtils.rewriteImportedRelPath(basePath, importUrl, mainDocUrl, '');
    assetPathUrl = pathPosix.dirname(assetPathUrl) + '/';
    dom5.setAttribute(node, 'assetpath', assetPathUrl);
  }
}
