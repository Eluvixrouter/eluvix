/**
 * Browser-safe Structured Outputs (`response_format: { type: 'json_schema' | 'json_object' }`)
 * per-engine translator and lightweight JSON Schema validator.
 *
 * IMPORTANT: Keep ZERO `node:*` imports in this module so client-side compiler,
 * diagnostics, and simulator bundles can import `@eluvix/router-core/structured-outputs`.
 */

export interface JsonSchemaDefinition {
  name?: string;
  description?: string;
  schema?: Record<string, any>;
  strict?: boolean;
}

export interface ResponseFormatSpec {
  type: 'text' | 'json_object' | 'json_schema';
  json_schema?: JsonSchemaDefinition;
  schema?: Record<string, any>;
  name?: string;
  strict?: boolean;
}

export type StructuredOutputTranslationMode =
  | 'none'
  | 'native'
  | 'ollama-format'
  | 'vllm-guided-json'
  | 'llamacpp-json-schema'
  | 'anthropic-tool'
  | 'gemini-schema'
  | 'prompt-hint';

export interface StructuredOutputTranslationResult {
  payload: Record<string, any>;
  mode: StructuredOutputTranslationMode;
  schema?: Record<string, any>;
  schemaName?: string;
  strict: boolean;
  isJsonMode: boolean;
}

export interface SchemaValidationResult {
  valid: boolean;
  errors: string[];
  parsed?: any;
  repairedJsonText?: string;
  wasFenceRepaired?: boolean;
}

/**
 * Extracts normalized `ResponseFormatSpec` from either OpenAI Chat Completions
 * `response_format` or OpenAI Responses API `text.format`.
 */
export function extractResponseFormatSpec(
  request: Record<string, any> | null | undefined
): ResponseFormatSpec | null {
  if (!request || typeof request !== 'object') return null;

  const rf = request.response_format || request.text?.format;
  if (!rf || typeof rf !== 'object') return null;

  if (rf.type === 'json_schema') {
    const js = rf.json_schema && typeof rf.json_schema === 'object' ? rf.json_schema : rf;
    return {
      type: 'json_schema',
      json_schema: {
        name: typeof js.name === 'string' && js.name.trim() ? js.name.trim() : 'structured_response',
        description: typeof js.description === 'string' ? js.description : undefined,
        schema: js.schema && typeof js.schema === 'object' ? js.schema : undefined,
        strict: Boolean(js.strict ?? rf.strict ?? false),
      },
      schema: js.schema && typeof js.schema === 'object' ? js.schema : undefined,
      name: typeof js.name === 'string' && js.name.trim() ? js.name.trim() : 'structured_response',
      strict: Boolean(js.strict ?? rf.strict ?? false),
    };
  }

  if (rf.type === 'json_object') {
    return {
      type: 'json_object',
      strict: Boolean(rf.strict ?? false),
    };
  }

  if (rf.type === 'text') {
    return { type: 'text', strict: false };
  }

  return null;
}

/**
 * Determines whether a candidate upstream supports structured JSON outputs.
 * When `strict: true` is requested, upstreams that explicitly disable structured outputs
 * or non-text media engines are excluded during candidate selection.
 */
export function supportsStructuredOutputs(
  upstream: {
    type?: string;
    endpoint?: string;
    models?: string[];
    supportsStructuredOutputs?: boolean;
  },
  strict = false
): boolean {
  if (!upstream || typeof upstream !== 'object') return false;
  if (upstream.supportsStructuredOutputs === false) return false;
  if (upstream.supportsStructuredOutputs === true) return true;

  const t = String(upstream.type || '').toLowerCase();
  if (t === 'comfyui' || t === 'speaches' || t === 'kokoro-tts') {
    return false;
  }

  if (strict) {
    // CLI text wrappers without grammar-constrained decoding cannot strictly guarantee schema compliance natively
    if (t === 'claude-code' || t === 'codex' || t === 'opencode' || t === 'gemini-cli') {
      return false;
    }
  }

  return true;
}

/**
 * Translates an OpenAI `response_format` specification into the target upstream engine's
 * native grammar-constrained decoding fields (`format` for Ollama, `guided_json` for vLLM/SGLang,
 * `json_schema` for llama.cpp/RamaLama, forced tool schema for Anthropic, `responseSchema` for Gemini).
 */
export function translateStructuredOutputFormat(
  payload: Record<string, any>,
  upstream: { type?: string; endpoint?: string }
): StructuredOutputTranslationResult {
  const spec = extractResponseFormatSpec(payload);
  if (!spec || spec.type === 'text') {
    return {
      payload,
      mode: 'none',
      strict: false,
      isJsonMode: false,
    };
  }

  const nextPayload: Record<string, any> = { ...payload };
  const schema = spec.json_schema?.schema || spec.schema;
  const schemaName = spec.json_schema?.name || spec.name || 'structured_output';
  const strict = Boolean(spec.strict || spec.json_schema?.strict);
  const type = String(upstream?.type || '').toLowerCase();

  // 1. Ollama: native `format` accepts either `'json'` or a full JSON Schema object (Ollama >= 0.5)
  if (type === 'ollama') {
    nextPayload.format = spec.type === 'json_schema' && schema ? schema : 'json';
    return {
      payload: nextPayload,
      mode: 'ollama-format',
      schema,
      schemaName,
      strict,
      isJsonMode: true,
    };
  }

  // 2. vLLM / SGLang: supports OpenAI `response_format` plus `guided_json` for XGrammar/Outlines
  if (type === 'vllm' || type === 'sglang') {
    if (spec.type === 'json_schema' && schema) {
      nextPayload.guided_json = schema;
      nextPayload.extra_body = {
        ...(nextPayload.extra_body && typeof nextPayload.extra_body === 'object'
          ? nextPayload.extra_body
          : {}),
        guided_json: schema,
      };
    }
    return {
      payload: nextPayload,
      mode: 'vllm-guided-json',
      schema,
      schemaName,
      strict,
      isJsonMode: true,
    };
  }

  // 3. llama.cpp / RamaLama / LocalAI / Lemonade: supports `response_format` + top-level `json_schema`
  if (type === 'llamacpp' || type === 'ramalama' || type === 'localai' || type === 'lemonade') {
    if (spec.type === 'json_schema' && schema) {
      nextPayload.json_schema = schema;
    }
    return {
      payload: nextPayload,
      mode: 'llamacpp-json-schema',
      schema,
      schemaName,
      strict,
      isJsonMode: true,
    };
  }

  // 4. Anthropic: translate `json_schema` into a forced tool call when no tools are already forced
  if (type === 'anthropic' && spec.type === 'json_schema' && schema) {
    const existingTools = Array.isArray(nextPayload.tools) ? [...nextPayload.tools] : [];
    const hasSchemaTool = existingTools.some(
      (t: any) => (t?.function?.name || t?.name) === schemaName
    );
    if (!hasSchemaTool) {
      existingTools.push({
        type: 'function',
        function: {
          name: schemaName,
          description:
            spec.json_schema?.description ||
            'Return the final response strictly conforming to this JSON schema.',
          parameters: schema,
        },
      });
    }
    nextPayload.tools = existingTools;
    nextPayload.tool_choice = {
      type: 'function',
      function: { name: schemaName },
    };
    return {
      payload: nextPayload,
      mode: 'anthropic-tool',
      schema,
      schemaName,
      strict,
      isJsonMode: true,
    };
  }

  // 5. Gemini: attach `generationConfig.responseMimeType` and `responseSchema`
  if (type === 'gemini' || type === 'antigravity') {
    nextPayload.generationConfig = {
      ...(nextPayload.generationConfig && typeof nextPayload.generationConfig === 'object'
        ? nextPayload.generationConfig
        : {}),
      responseMimeType: 'application/json',
      ...(schema ? { responseSchema: schema } : {}),
    };
    return {
      payload: nextPayload,
      mode: 'gemini-schema',
      schema,
      schemaName,
      strict,
      isJsonMode: true,
    };
  }

  return {
    payload: nextPayload,
    mode: 'native',
    schema,
    schemaName,
    strict,
    isJsonMode: true,
  };
}

/**
 * Strips leading/trailing Markdown code fences (` ```json ... ``` `) if a model
 * wraps its JSON output in fences.
 */
export function stripMarkdownJsonFences(rawText: string): {
  cleaned: string;
  repaired: boolean;
} {
  const trimmed = (rawText || '').trim();
  const fenceMatch = trimmed.match(/^```(?:json|JSON)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/);
  if (fenceMatch) {
    return { cleaned: fenceMatch[1].trim(), repaired: true };
  }
  return { cleaned: trimmed, repaired: false };
}

function checkSchemaNode(
  value: any,
  schema: Record<string, any>,
  pathPrefix: string,
  errors: string[],
  strictMode: boolean
): void {
  if (!schema || typeof schema !== 'object') return;

  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    const branchValid = schema.anyOf.some((branch: Record<string, any>) => {
      const subErrors: string[] = [];
      checkSchemaNode(value, branch, pathPrefix, subErrors, strictMode);
      return subErrors.length === 0;
    });
    if (!branchValid) {
      errors.push(`${pathPrefix}: value did not match anyOf branches`);
    }
    return;
  }

  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    let matches = 0;
    for (const branch of schema.oneOf) {
      const subErrors: string[] = [];
      checkSchemaNode(value, branch, pathPrefix, subErrors, strictMode);
      if (subErrors.length === 0) matches += 1;
    }
    if (matches !== 1) {
      errors.push(`${pathPrefix}: value matched ${matches} oneOf branches (expected 1)`);
    }
    return;
  }

  if (Array.isArray(schema.enum)) {
    const matched = schema.enum.some((item: any) => JSON.stringify(item) === JSON.stringify(value));
    if (!matched) {
      errors.push(`${pathPrefix}: value ${JSON.stringify(value)} is not in enum ${JSON.stringify(schema.enum)}`);
      return;
    }
  }

  if (schema.type !== undefined) {
    const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actualType =
      value === null
        ? 'null'
        : Array.isArray(value)
        ? 'array'
        : typeof value === 'number' && Number.isInteger(value)
        ? 'integer'
        : typeof value;

    const typeMatched = allowedTypes.some((t: string) => {
      if (t === 'number' && (actualType === 'number' || actualType === 'integer')) return true;
      return t === actualType;
    });

    if (!typeMatched) {
      errors.push(`${pathPrefix}: expected type ${allowedTypes.join('|')}, got ${actualType}`);
      return;
    }
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push(`${pathPrefix}: string length ${value.length} < minLength ${schema.minLength}`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      errors.push(`${pathPrefix}: string length ${value.length} > maxLength ${schema.maxLength}`);
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push(`${pathPrefix}: number ${value} < minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push(`${pathPrefix}: number ${value} > maximum ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push(`${pathPrefix}: array length ${value.length} < minItems ${schema.minItems}`);
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errors.push(`${pathPrefix}: array length ${value.length} > maxItems ${schema.maxItems}`);
    }
    if (schema.items && typeof schema.items === 'object') {
      value.forEach((item, idx) => {
        checkSchemaNode(item, schema.items, `${pathPrefix}[${idx}]`, errors, strictMode);
      });
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const requiredProps: string[] = Array.isArray(schema.required) ? schema.required : [];
    for (const reqKey of requiredProps) {
      if (!(reqKey in value) || value[reqKey] === undefined) {
        errors.push(`${pathPrefix}: missing required property "${reqKey}"`);
      }
    }

    const props: Record<string, any> =
      schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    for (const [k, propSchema] of Object.entries(props)) {
      if (k in value && value[k] !== undefined) {
        checkSchemaNode(value[k], propSchema as Record<string, any>, `${pathPrefix}.${k}`, errors, strictMode);
      }
    }

    const disallowAdditional =
      schema.additionalProperties === false ||
      (strictMode && schema.additionalProperties === undefined && Object.keys(props).length > 0);
    if (disallowAdditional) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) {
          errors.push(`${pathPrefix}: additional property "${key}" is not allowed`);
        }
      }
    }
  }
}

/**
 * Validates a raw JSON string or parsed value against an optional JSON Schema.
 */
export function validateAgainstJsonSchema(
  rawInput: unknown,
  schema?: Record<string, any>,
  strictMode = false
): SchemaValidationResult {
  let parsed: any = rawInput;
  let repairedJsonText: string | undefined;
  let wasFenceRepaired = false;

  if (typeof rawInput === 'string') {
    const { cleaned, repaired } = stripMarkdownJsonFences(rawInput);
    wasFenceRepaired = repaired;
    try {
      parsed = JSON.parse(cleaned);
      if (repaired) {
        repairedJsonText = JSON.stringify(parsed);
      }
    } catch (err: any) {
      return {
        valid: false,
        errors: [`Invalid JSON syntax: ${err?.message || 'parse failed'}`],
      };
    }
  }

  if (!schema || typeof schema !== 'object') {
    const isObjOrArr = parsed !== null && typeof parsed === 'object';
    return {
      valid: isObjOrArr,
      errors: isObjOrArr ? [] : ['Expected a JSON object or array'],
      parsed,
      repairedJsonText,
      wasFenceRepaired,
    };
  }

  const errors: string[] = [];
  checkSchemaNode(parsed, schema, '$', errors, strictMode);

  return {
    valid: errors.length === 0,
    errors,
    parsed,
    repairedJsonText,
    wasFenceRepaired,
  };
}
