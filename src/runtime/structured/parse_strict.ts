/**
 * Strict JSON parse for final answers.
 * Rejects non-UTF-8, trailing non-whitespace, and duplicate keys at every depth
 * after escape decoding ("\u0061" and "a" are the same key).
 * Does not use JSON.parse, which last-wins and hides duplicates.
 */

export type ParseStrictResult =
  | { ok: true; value: unknown }
  | { ok: false; code: "not_json" };

const NOT_JSON: ParseStrictResult = { ok: false, code: "not_json" };

export function parseStrictAnswer(input: string | Uint8Array): ParseStrictResult {
  let text: string;
  if (typeof input === "string") {
    if (!roundTripsAsUtf8(input)) return NOT_JSON;
    text = input;
  } else {
    if (!(input instanceof Uint8Array)) return NOT_JSON;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(input);
    } catch {
      return NOT_JSON;
    }
  }
  const parser = new StrictJsonParser(text);
  try {
    parser.skipWs();
    if (parser.eof()) return NOT_JSON;
    const value = parser.parseValue();
    parser.skipWs();
    if (!parser.eof()) return NOT_JSON;
    return { ok: true, value };
  } catch {
    return NOT_JSON;
  }
}

function roundTripsAsUtf8(s: string): boolean {
  const bytes = new TextEncoder().encode(s);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes) === s;
  } catch {
    return false;
  }
}

class StrictJsonParser {
  private i = 0;
  constructor(private readonly s: string) {}

  eof(): boolean {
    return this.i >= this.s.length;
  }

  skipWs(): void {
    while (this.i < this.s.length) {
      const c = this.s.charCodeAt(this.i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) this.i += 1;
      else break;
    }
  }

  parseValue(): unknown {
    this.skipWs();
    if (this.eof()) throw new Error("eof");
    const c = this.s[this.i];
    if (c === "{") return this.parseObject();
    if (c === "[") return this.parseArray();
    if (c === '"') return this.parseString();
    if (c === "t") return this.parseLiteral("true", true);
    if (c === "f") return this.parseLiteral("false", false);
    if (c === "n") return this.parseLiteral("null", null);
    if (c === "-" || (c >= "0" && c <= "9")) return this.parseNumber();
    throw new Error("value");
  }

  private parseLiteral(lit: string, value: unknown): unknown {
    if (this.s.slice(this.i, this.i + lit.length) !== lit) throw new Error("lit");
    this.i += lit.length;
    return value;
  }

  private parseObject(): Record<string, unknown> {
    this.expect("{");
    this.skipWs();
    const obj: Record<string, unknown> = {};
    const seen = new Set<string>();
    if (this.peek() === "}") {
      this.i += 1;
      return obj;
    }
    while (true) {
      this.skipWs();
      if (this.peek() !== '"') throw new Error("key");
      const key = this.parseString();
      if (seen.has(key)) throw new Error("dup");
      seen.add(key);
      this.skipWs();
      this.expect(":");
      const value = this.parseValue();
      obj[key] = value;
      this.skipWs();
      const n = this.peek();
      if (n === ",") {
        this.i += 1;
        continue;
      }
      if (n === "}") {
        this.i += 1;
        return obj;
      }
      throw new Error("obj");
    }
  }

  private parseArray(): unknown[] {
    this.expect("[");
    this.skipWs();
    const arr: unknown[] = [];
    if (this.peek() === "]") {
      this.i += 1;
      return arr;
    }
    while (true) {
      arr.push(this.parseValue());
      this.skipWs();
      const n = this.peek();
      if (n === ",") {
        this.i += 1;
        continue;
      }
      if (n === "]") {
        this.i += 1;
        return arr;
      }
      throw new Error("arr");
    }
  }

  private parseString(): string {
    this.expect('"');
    let out = "";
    while (!this.eof()) {
      const c = this.s[this.i];
      if (c === '"') {
        this.i += 1;
        return out;
      }
      if (c === "\\") {
        this.i += 1;
        if (this.eof()) throw new Error("esc");
        const e = this.s[this.i];
        this.i += 1;
        if (e === '"' || e === "\\" || e === "/") out += e;
        else if (e === "b") out += "\b";
        else if (e === "f") out += "\f";
        else if (e === "n") out += "\n";
        else if (e === "r") out += "\r";
        else if (e === "t") out += "\t";
        else if (e === "u") {
          const hex = this.s.slice(this.i, this.i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error("u");
          this.i += 4;
          const cu = parseInt(hex, 16);
          if (cu >= 0xd800 && cu <= 0xdbff) {
            if (this.s[this.i] !== "\\" || this.s[this.i + 1] !== "u") throw new Error("sur");
            const hex2 = this.s.slice(this.i + 2, this.i + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex2)) throw new Error("sur");
            const cu2 = parseInt(hex2, 16);
            if (cu2 < 0xdc00 || cu2 > 0xdfff) throw new Error("sur");
            this.i += 6;
            out += String.fromCharCode(cu, cu2);
          } else if (cu >= 0xdc00 && cu <= 0xdfff) {
            throw new Error("sur");
          } else {
            out += String.fromCharCode(cu);
          }
        } else throw new Error("esc");
        continue;
      }
      const code = this.s.charCodeAt(this.i);
      if (code <= 0x1f) throw new Error("ctrl");
      out += c;
      this.i += 1;
    }
    throw new Error("str");
  }

  private parseNumber(): number {
    const start = this.i;
    if (this.peek() === "-") this.i += 1;
    if (this.eof()) throw new Error("num");
    if (this.peek() === "0") {
      this.i += 1;
    } else if (this.peek() >= "1" && this.peek() <= "9") {
      while (this.peek() >= "0" && this.peek() <= "9") this.i += 1;
    } else throw new Error("num");
    if (this.peek() === ".") {
      this.i += 1;
      if (!(this.peek() >= "0" && this.peek() <= "9")) throw new Error("frac");
      while (this.peek() >= "0" && this.peek() <= "9") this.i += 1;
    }
    if (this.peek() === "e" || this.peek() === "E") {
      this.i += 1;
      if (this.peek() === "+" || this.peek() === "-") this.i += 1;
      if (!(this.peek() >= "0" && this.peek() <= "9")) throw new Error("exp");
      while (this.peek() >= "0" && this.peek() <= "9") this.i += 1;
    }
    const raw = this.s.slice(start, this.i);
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error("num");
    return n;
  }

  private peek(): string {
    return this.i < this.s.length ? this.s[this.i] : "";
  }

  private expect(ch: string): void {
    if (this.s[this.i] !== ch) throw new Error("exp");
    this.i += 1;
  }
}
