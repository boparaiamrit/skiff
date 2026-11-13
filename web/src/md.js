import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { html, bridge, toast } from './core.js';

marked.setOptions({ gfm: true, breaks: false });

const cache = new Map();
export function mdToHTML(src) {
  if (cache.has(src)) return cache.get(src);
  const out = DOMPurify.sanitize(marked.parse(src || ''), { ADD_ATTR: ['target'] });
  if (cache.size > 500) cache.clear();
  cache.set(src, out);
  return out;
}

// Links open in the phone's browser; code blocks get a copy button on tap.
function onClick(e) {
  const a = e.target.closest('a');
  if (a && a.href) {
    e.preventDefault();
    bridge.openExternal(a.href);
    return;
  }
  const pre = e.target.closest('pre');
  if (pre && e.target.closest('.md') && e.detail === 2) {
    bridge.copy(pre.innerText);
    toast('Copied code');
  }
}

export function Markdown({ text, class: cls = '' }) {
  return html`<div class=${'md ' + cls} onClick=${onClick} dangerouslySetInnerHTML=${{ __html: mdToHTML(text) }} />`;
}
