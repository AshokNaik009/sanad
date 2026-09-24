// Validates e-claim XML against the official DOH XSDs imported into data/ref/xsd.
// Covers what those schemas use: nested sequences (order, minOccurs/maxOccurs), named simple
// types from CommonTypes (enumerations, patterns, min/max length) and the built-in
// string/float/integer/nonNegativeInteger/base64Binary types.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { REF_DIR } from "../data/ref-import.ts";
import type { Regulator } from "../domain/types.ts";

export type XsdName = "ClaimSubmission" | "RemittanceAdvice" | "PriorRequest" | "PriorAuthorization";

export interface XsdError {
  path: string;
  message: string;
}

interface ElementDecl {
  name: string;
  min: number;
  max: number;
  type?: string;
  children?: ElementDecl[];
}

interface SimpleType {
  base: string;
  enums: string[];
  patterns: RegExp[];
  minLength?: number;
  maxLength?: number;
}

interface CompiledSchema {
  roots: Map<string, ElementDecl>;
  types: Map<string, SimpleType>;
}

/**
 * The DOH schema is the reference layout; Dubai (DHA eClaimLink) uses the same structure but its
 * own header disposition values, so those are swapped in when the organisation files with DHA.
 */
const REGULATOR_ENUMS: Record<Regulator, Record<string, string[]>> = {
  DOH: {},
  DHA: { "Header/DispositionFlag": ["PRODUCTION", "TEST DATA"] },
};

type Node = Record<string, unknown>;
const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "", parseTagValue: false, trimValues: true });

const local = (name: string) => name.slice(name.indexOf(":") + 1);
const tagOf = (node: Node) => Object.keys(node).find((k) => k !== ":@") ?? "";
const kids = (node: Node) => (node[tagOf(node)] as Node[] | undefined) ?? [];
const attrs = (node: Node) => (node[":@"] as Record<string, string> | undefined) ?? {};
const elementsOf = (nodes: Node[]) => nodes.filter((n) => !["#text", "#comment", "?xml"].includes(tagOf(n)));

function elementDecl(node: Node): ElementDecl {
  const a = attrs(node);
  const decl: ElementDecl = {
    name: a.name,
    min: a.minOccurs === undefined ? 1 : Number(a.minOccurs),
    max: a.maxOccurs === "unbounded" ? Number.POSITIVE_INFINITY : a.maxOccurs === undefined ? 1 : Number(a.maxOccurs),
    type: a.type ? local(a.type) : undefined,
  };
  const complex = kids(node).find((k) => local(tagOf(k)) === "complexType");
  const sequence = complex && kids(complex).find((k) => local(tagOf(k)) === "sequence");
  if (sequence) decl.children = kids(sequence).filter((k) => local(tagOf(k)) === "element").map(elementDecl);
  return decl;
}

function simpleType(node: Node): SimpleType | undefined {
  const restriction = kids(node).find((k) => local(tagOf(k)) === "restriction");
  if (!restriction) return undefined;
  const type: SimpleType = { base: local(attrs(restriction).base ?? "string"), enums: [], patterns: [] };
  for (const facet of kids(restriction)) {
    const value = attrs(facet).value;
    switch (local(tagOf(facet))) {
      case "enumeration":
        type.enums.push(value);
        break;
      case "pattern":
        type.patterns.push(new RegExp(`^(?:${value})$`));
        break;
      case "minLength":
        type.minLength = Number(value);
        break;
      case "maxLength":
        type.maxLength = Number(value);
        break;
    }
  }
  return type;
}

function compile(texts: string[]): CompiledSchema {
  const schema: CompiledSchema = { roots: new Map(), types: new Map() };
  for (const text of texts) {
    const schemaNode = elementsOf(parser.parse(text) as Node[]).find((n) => local(tagOf(n)) === "schema");
    for (const node of schemaNode ? kids(schemaNode) : []) {
      const kind = local(tagOf(node));
      if (kind === "element") schema.roots.set(attrs(node).name, elementDecl(node));
      else if (kind === "simpleType") {
        const t = simpleType(node);
        if (t) schema.types.set(attrs(node).name, t);
      }
    }
  }
  return schema;
}

const cache = new Map<string, CompiledSchema>();
function schemaFor(name: XsdName, dir: string): CompiledSchema {
  const key = `${dir}|${name}`;
  let schema = cache.get(key);
  if (!schema) {
    schema = compile([readFileSync(join(dir, "xsd", `${name}.xsd`), "utf8"), readFileSync(join(dir, "xsd", "CommonTypes.xsd"), "utf8")]);
    cache.set(key, schema);
  }
  return schema;
}

/** Forget compiled schemas (after Regulator Watch saves newer XSDs). */
export function resetXsdCache(): void {
  cache.clear();
}

const BUILTIN: Record<string, (v: string) => boolean> = {
  string: () => true,
  float: (v) => /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$|^(INF|-INF|NaN)$/.test(v),
  decimal: (v) => /^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(v),
  integer: (v) => /^[+-]?\d+$/.test(v),
  nonNegativeInteger: (v) => /^\+?\d+$/.test(v),
  base64Binary: (v) => /^[A-Za-z0-9+/=\s]*$/.test(v),
};

function checkValue(schema: CompiledSchema, typeName: string, value: string, enumOverride?: string[], depth = 0): string | null {
  const builtin = BUILTIN[typeName];
  if (builtin) return builtin(value) ? null : `"${value}" is not a valid ${typeName}`;
  const type = schema.types.get(typeName);
  if (!type || depth > 8) return null;
  const baseError = checkValue(schema, type.base, value, undefined, depth + 1);
  if (baseError) return baseError;
  const enums = depth === 0 && enumOverride ? enumOverride : type.enums;
  if (enums.length && !enums.includes(value)) return `"${value}" is not an allowed value (${enums.slice(0, 8).join(", ")}${enums.length > 8 ? ", …" : ""})`;
  if (type.patterns.length && !type.patterns.some((p) => p.test(value))) return `"${value}" does not match the required format`;
  if (type.minLength !== undefined && value.length < type.minLength) return type.minLength === 1 ? "must not be empty" : `must be at least ${type.minLength} characters`;
  if (type.maxLength !== undefined && value.length > type.maxLength) return `must be at most ${type.maxLength} characters`;
  return null;
}

/** Validates `xml` against the named official schema. Returns [] when the document conforms. */
export function validateXml(xml: string, name: XsdName, options: { regulator?: Regulator; dir?: string } = {}): XsdError[] {
  const schema = schemaFor(name, options.dir ?? REF_DIR);
  const overrides = REGULATOR_ENUMS[options.regulator ?? "DOH"];
  const errors: XsdError[] = [];
  let doc: Node[];
  try {
    doc = parser.parse(xml) as Node[];
  } catch (error) {
    return [{ path: "/", message: `Not well-formed XML: ${(error as Error).message}` }];
  }
  const root = elementsOf(doc)[0];
  const rootDecl = root && schema.roots.get(tagOf(root));
  if (!root || !rootDecl) return [{ path: "/", message: `Root element must be ${[...schema.roots.keys()].join(" or ")}` }];

  const visit = (node: Node, decl: ElementDecl, path: string, shortPath: string) => {
    if (errors.length >= 25) return;
    const children = elementsOf(kids(node));
    if (decl.children) {
      let i = 0;
      for (const child of decl.children) {
        let count = 0;
        while (i < children.length && tagOf(children[i]) === child.name) {
          count++;
          visit(children[i], child, `${path}/${child.name}${child.max > 1 ? `[${count}]` : ""}`, `${shortPath}/${child.name}`);
          i++;
        }
        if (count < child.min) errors.push({ path: `${path}/${child.name}`, message: `${child.name} is required in ${decl.name}` });
        if (count > child.max) errors.push({ path: `${path}/${child.name}`, message: `${child.name} may occur at most ${child.max} time(s) in ${decl.name}` });
      }
      if (i < children.length) {
        const extra = tagOf(children[i]);
        const known = decl.children.some((c) => c.name === extra);
        errors.push({ path: `${path}/${extra}`, message: known ? `${extra} is out of order in ${decl.name}` : `Unexpected element ${extra} in ${decl.name}` });
      }
      return;
    }
    if (children.length) {
      errors.push({ path, message: `${decl.name} must not contain child elements` });
      return;
    }
    const text = kids(node)
      .filter((k) => tagOf(k) === "#text")
      .map((k) => String(k["#text"]))
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    const problem = checkValue(schema, decl.type ?? "string", text, overrides[shortPath.replace(/^\/[^/]+\//, "")]);
    if (problem) errors.push({ path, message: `${decl.name}: ${problem}` });
  };
  visit(root, rootDecl, `/${rootDecl.name}`, `/${rootDecl.name}`);
  return errors;
}
