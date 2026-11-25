/**
 * Context expressions ("when clauses"), used for command enablement, toggle
 * state and keybinding scope.
 *
 * Grammar (no evaluation of arbitrary code, no property access, no calls):
 *
 *   or      := and ( '||' and )*
 *   and     := unary ( '&&' unary )*
 *   unary   := '!' unary | compare
 *   compare := primary ( ( '==' | '!=' | '<' | '<=' | '>' | '>=' ) primary )?
 *   primary := '(' or ')' | IDENT | NUMBER | STRING | 'true' | 'false'
 *
 * IDENT is a dotted context key such as `tab.canGoBack`. Unknown keys are
 * `undefined`, which is falsy, so a typo disables a command rather than
 * enabling it.
 */

export type ContextValue = string | number | boolean | undefined;
export type Context = Readonly<Record<string, ContextValue>>;

export type WhenNode =
  | { t: 'lit'; v: string | number | boolean }
  | { t: 'key'; k: string }
  | { t: 'not'; a: WhenNode }
  | { t: 'bin'; op: '&&' | '||' | '==' | '!=' | '<' | '<=' | '>' | '>='; a: WhenNode; b: WhenNode };

export class WhenSyntaxError extends Error {
  readonly source: string;
  readonly pos: number;
  constructor(message: string, source: string, pos: number) {
    super(`${message} at ${pos} in "${source}"`);
    this.source = source;
    this.pos = pos;
    this.name = 'WhenSyntaxError';
  }
}

type Tok = { k: 'op' | 'ident' | 'num' | 'str' | 'end'; v: string; pos: number };

const MAX_LENGTH = 512;
const MAX_DEPTH = 32;

function tokenize(src: string): Tok[] {
  if (src.length > MAX_LENGTH) throw new WhenSyntaxError('expression too long', src.slice(0, 40), 0);
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t') { i++; continue; }
    const two = src.slice(i, i + 2);
    if (['&&', '||', '==', '!=', '<=', '>='].includes(two)) { out.push({ k: 'op', v: two, pos: i }); i += 2; continue; }
    if ('!()<>'.includes(c)) { out.push({ k: 'op', v: c, pos: i }); i++; continue; }
    if (c === "'" || c === '"') {
      const end = src.indexOf(c, i + 1);
      if (end < 0) throw new WhenSyntaxError('unterminated string', src, i);
      out.push({ k: 'str', v: src.slice(i + 1, end), pos: i });
      i = end + 1;
      continue;
    }
    const num = /^-?\d+(\.\d+)?/.exec(src.slice(i));
    if (num) { out.push({ k: 'num', v: num[0], pos: i }); i += num[0].length; continue; }
    const id = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(src.slice(i));
    if (id) { out.push({ k: 'ident', v: id[0], pos: i }); i += id[0].length; continue; }
    throw new WhenSyntaxError(`unexpected character "${c}"`, src, i);
  }
  out.push({ k: 'end', v: '', pos: src.length });
  return out;
}

export function parseWhen(src: string): WhenNode {
  const toks = tokenize(src);
  let p = 0;
  let depth = 0;
  const peek = () => toks[p]!;
  const isOp = (v: string) => peek().k === 'op' && peek().v === v;
  const fail = (msg: string): never => { throw new WhenSyntaxError(msg, src, peek().pos); };

  function or(): WhenNode {
    let a = and();
    while (isOp('||')) { p++; a = { t: 'bin', op: '||', a, b: and() }; }
    return a;
  }
  function and(): WhenNode {
    let a = unary();
    while (isOp('&&')) { p++; a = { t: 'bin', op: '&&', a, b: unary() }; }
    return a;
  }
  function unary(): WhenNode {
    if (isOp('!')) {
      p++;
      if (++depth > MAX_DEPTH) fail('expression too deeply nested');
      const a = unary();
      depth--;
      return { t: 'not', a };
    }
    return compare();
  }
  function compare(): WhenNode {
    const a = primary();
    const t = peek();
    if (t.k === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(t.v)) {
      p++;
      return { t: 'bin', op: t.v as '==', a, b: primary() };
    }
    return a;
  }
  function primary(): WhenNode {
    const t = peek();
    if (isOp('(')) {
      p++;
      if (++depth > MAX_DEPTH) fail('expression too deeply nested');
      const a = or();
      depth--;
      if (!isOp(')')) fail('expected ")"');
      p++;
      return a;
    }
    if (t.k === 'ident') {
      p++;
      if (t.v === 'true') return { t: 'lit', v: true };
      if (t.v === 'false') return { t: 'lit', v: false };
      return { t: 'key', k: t.v };
    }
    if (t.k === 'num') { p++; return { t: 'lit', v: Number(t.v) }; }
    if (t.k === 'str') { p++; return { t: 'lit', v: t.v }; }
    return fail(t.k === 'end' ? 'unexpected end of expression' : `unexpected "${t.v}"`);
  }

  const node = or();
  if (peek().k !== 'end') fail(`unexpected "${peek().v}"`);
  return node;
}

function value(n: WhenNode, ctx: Context): ContextValue {
  switch (n.t) {
    case 'lit': return n.v;
    // Own properties only: `constructor`, `__proto__` and the like are never context keys.
    case 'key': return Object.hasOwn(ctx, n.k) ? ctx[n.k] : undefined;
    case 'not': return !value(n.a, ctx);
    case 'bin': {
      if (n.op === '&&') return Boolean(value(n.a, ctx)) && Boolean(value(n.b, ctx));
      if (n.op === '||') return Boolean(value(n.a, ctx)) || Boolean(value(n.b, ctx));
      const a = value(n.a, ctx);
      const b = value(n.b, ctx);
      if (n.op === '==') return a === b;
      if (n.op === '!=') return a !== b;
      if (typeof a !== 'number' || typeof b !== 'number') return false;
      if (n.op === '<') return a < b;
      if (n.op === '<=') return a <= b;
      if (n.op === '>') return a > b;
      return a >= b;
    }
  }
}

export function evaluateWhen(node: WhenNode, ctx: Context): boolean {
  return Boolean(value(node, ctx));
}

/** Context keys an expression reads; used to check them against the known key list. */
export function whenKeys(node: WhenNode, out = new Set<string>()): Set<string> {
  if (node.t === 'key') out.add(node.k);
  else if (node.t === 'not') whenKeys(node.a, out);
  else if (node.t === 'bin') { whenKeys(node.a, out); whenKeys(node.b, out); }
  return out;
}

/** Compiled expression cache: catalog expressions are parsed once. */
export class WhenCache {
  private readonly cache = new Map<string, WhenNode>();
  test(expr: string | undefined, ctx: Context, ifAbsent = true): boolean {
    if (expr === undefined) return ifAbsent;
    let node = this.cache.get(expr);
    if (!node) { node = parseWhen(expr); this.cache.set(expr, node); }
    return evaluateWhen(node, ctx);
  }
}
