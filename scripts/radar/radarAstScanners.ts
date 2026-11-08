import {
  ALLOWED_LOCAL_BUFFER_NAMES,
  CROSS_CONTROLLER_MUTATION_LIMIT,
  FILE_ANY_LIMIT,
  isGraphicsOrDomTarget,
  PIPELINE_MUTATION_PROP_LIMIT,
  PROXY_ACCESSOR_LIMIT,
  WIDE_WAIST_PORT_READ_LIMIT,
} from './radarConstantsAndFs.ts';

export function checkLanguageAndEmoji(rel: string, content: string, errors: string[]): void {
  const cjkRegex = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/;
  const emojiRegex = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u;
  const allowedTechnicalSymbols = /[±×÷→←↑↓↔↗↘↙↖⇒⇐⇔µαβγδθλμπσωΔΩ°✓✗✔✘⚠⚡]/g;

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (cjkRegex.test(line)) {
      const sample = line.trim().slice(0, 80);
      errors.push(
        `[NON-ENGLISH / EMOJI VIOLATION] ${rel}:${i + 1} contains non-English CJK characters: "${sample}"`
      );
      break;
    }
    const sanitized = line.replace(allowedTechnicalSymbols, '');
    if (emojiRegex.test(sanitized)) {
      const sample = line.trim().slice(0, 80);
      errors.push(
        `[NON-ENGLISH / EMOJI VIOLATION] ${rel}:${i + 1} contains forbidden emoji character: "${sample}"`
      );
      break;
    }
  }
}

export function checkValueReExports(
  rel: string,
  codeWithoutComments: string,
  errors: string[]
): void {
  if (rel === 'src/ui-core/index.ts') return;

  const reExportRegex = /\bexport\s+(type\s+)?(\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = reExportRegex.exec(codeWithoutComments)) !== null) {
    const isTypeExport = Boolean(match[1]);
    if (isTypeExport) continue;

    const clause = match[2];
    const fromSpec = match[3];
    if (clause === '*') {
      errors.push(
        `[RE-EXPORT FACADE VIOLATION] ${rel} re-exports wildcard values from "${fromSpec}". Import directly from the defining source module.`
      );
      continue;
    }

    const inner = clause.slice(1, -1);
    const specifiers = inner
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const valueSpecs = specifiers.filter((s) => !/^type\s+/.test(s));
    if (valueSpecs.length > 0) {
      errors.push(
        `[RE-EXPORT FACADE VIOLATION] ${rel} re-exports values { ${valueSpecs.slice(0, 4).join(', ')}${valueSpecs.length > 4 ? ', ...' : ''} } from "${fromSpec}". Import directly from the defining source module.`
      );
    }
  }

  const importedValueLocals = new Map<string, string>();
  const importStmtRegex = /\bimport\s+(type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
  let impMatch: RegExpExecArray | null;
  while ((impMatch = importStmtRegex.exec(codeWithoutComments)) !== null) {
    if (impMatch[1]) continue;
    const clause = impMatch[2].trim();
    const fromSpec = impMatch[3];

    const namedMatch = clause.match(/\{([^}]*)\}/);
    if (namedMatch) {
      for (const rawSpec of namedMatch[1].split(',')) {
        const spec = rawSpec.trim();
        if (!spec || /^type\s+/.test(spec)) continue;
        const asParts = spec.split(/\s+as\s+/);
        const localName = (asParts[1] || asParts[0]).trim();
        if (localName) importedValueLocals.set(localName, fromSpec);
      }
    }

    const defaultPart = clause.replace(/\{[^}]*\}/, '').replace(/,/g, '').trim();
    if (defaultPart && !defaultPart.startsWith('*') && /^[A-Za-z_$][\w$]*$/.test(defaultPart)) {
      importedValueLocals.set(defaultPart, fromSpec);
    }
  }

  if (importedValueLocals.size > 0) {
    const localExportRegex = /\bexport\s+(type\s+)?\{([^}]*)\}(?!\s*from\b)/g;
    let expMatch: RegExpExecArray | null;
    while ((expMatch = localExportRegex.exec(codeWithoutComments)) !== null) {
      if (expMatch[1]) continue;
      const reExportedLocals: string[] = [];
      for (const rawSpec of expMatch[2].split(',')) {
        const spec = rawSpec.trim();
        if (!spec || /^type\s+/.test(spec)) continue;
        const localName = spec.split(/\s+as\s+/)[0].trim();
        if (importedValueLocals.has(localName)) {
          reExportedLocals.push(`${localName} (from "${importedValueLocals.get(localName)}")`);
        }
      }
      if (reExportedLocals.length > 0) {
        errors.push(
          `[RE-EXPORT FACADE VIOLATION] ${rel} indirectly re-exports imported values { ${reExportedLocals.slice(0, 4).join(', ')}${reExportedLocals.length > 4 ? ', ...' : ''} }. Import directly from the defining source module.`
        );
      }
    }
  }
}

export function checkAnyPurity(rel: string, codeWithoutComments: string, errors: string[]): void {
  const anyMatches =
    codeWithoutComments.match(/(?::\s*any\b|\bas\s+any\b|<any>|Record<[^,>]+,\s*any>)/g) || [];
  const boundaryAnyRegex =
    /\bexport\s+(?:async\s+)?function\s+\w+[^{]*:\s*any\b|\bexport\s+interface\s+\w+\s*\{[^}]*:\s*any\b/s;
  const hasBoundaryAny = boundaryAnyRegex.test(codeWithoutComments);

  if (anyMatches.length > FILE_ANY_LIMIT || hasBoundaryAny) {
    const reason =
      anyMatches.length > FILE_ANY_LIMIT
        ? `${anyMatches.length} untyped 'any' occurrences (limit: ${FILE_ANY_LIMIT})`
        : `untyped 'any' in exported module boundary signature/interface`;
    errors.push(
      `[UNTYPED ANY VIOLATION] ${rel} contains ${reason}. Declare explicit TypeScript interfaces across module boundaries.`
    );
  }
}

export function checkProxyBloat(rel: string, codeWithoutComments: string, errors: string[]): void {
  if (rel.endsWith('RocketSimStateViews.ts')) return;

  const getterMatches =
    codeWithoutComments.match(
      /\bget\s+[a-zA-Z_$][a-zA-Z0-9_$]*\s*\(\s*\)[^{]*\{\s*return\s+(?:this|simulator|self)\.[a-zA-Z0-9_$.?]+\s*;\s*\}/g
    ) || [];
  const setterMatches =
    codeWithoutComments.match(
      /\bset\s+[a-zA-Z_$][a-zA-Z0-9_$]*\s*\([^)]*\)[^{]*\{\s*(?:this|simulator|self)\.[a-zA-Z0-9_$.]+(?:\([^)]*\)|\s*=\s*[^;]+);\s*\}/g
    ) || [];

  const totalProxies = getterMatches.length + setterMatches.length;
  if (totalProxies > PROXY_ACCESSOR_LIMIT) {
    errors.push(
      `[PROXY BLOAT VIOLATION] ${rel} defines ${totalProxies} pass-through getter/setter proxies (${getterMatches.length} getters, ${setterMatches.length} setters; limit: ${PROXY_ACCESSOR_LIMIT}). Expose narrow domain methods or sub-controller ports instead of wide-waist forwarding accessors.`
    );
  }
}

export function checkAntiGutSharingAndMutations(
  rel: string,
  codeWithoutComments: string,
  errors: string[]
): void {
  if (rel.startsWith('src/ui-')) return;
  if (/(Types|Constants|Config)\.ts$/.test(rel)) return;

  const hasExportedClass = /\bexport\s+class\s+\w+/.test(codeWithoutComments);
  const isPipelineOrMath = /(Pipeline|Math)\.ts$/.test(rel);
  const isHelperNamed = /(Helper|Stepper|Runner)\.ts$/.test(rel);

  if (isPipelineOrMath || isHelperNamed || !hasExportedClass) {
    const localAllocations = new Set<string>();
    const localAllocRegex =
      /\b(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:new\s+|\{|\[|document\.|this\.|create|build|clone|make|Object\.create|Object\.assign\(\s*\{\s*\})/g;
    let allocMatch: RegExpExecArray | null;
    while ((allocMatch = localAllocRegex.exec(codeWithoutComments)) !== null) {
      localAllocations.add(allocMatch[1]);
    }

    const mutatedPropsByTarget = new Map<string, Set<string>>();
    const mutationRegex =
      /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?:=(?!=)|[+\-*/%&|^]=|\+\+|--)/g;
    let mutMatch: RegExpExecArray | null;
    while ((mutMatch = mutationRegex.exec(codeWithoutComments)) !== null) {
      const target = mutMatch[1];
      const prop = mutMatch[2];
      if (ALLOWED_LOCAL_BUFFER_NAMES.has(target)) continue;
      if (localAllocations.has(target)) continue;
      if (isGraphicsOrDomTarget(target)) continue;

      if (!mutatedPropsByTarget.has(target)) {
        mutatedPropsByTarget.set(target, new Set());
      }
      mutatedPropsByTarget.get(target)!.add(prop);
    }

    for (const [target, props] of mutatedPropsByTarget.entries()) {
      if (props.size > PIPELINE_MUTATION_PROP_LIMIT) {
        const sampleProps = [...props].sort().slice(0, 6).join(', ');
        errors.push(
          `[PIPELINE MUTATION VIOLATION] ${rel} mutates ${props.size} properties in-place on external object '${target}' (${sampleProps}${props.size > 6 ? ', ...' : ''}; limit: ${PIPELINE_MUTATION_PROP_LIMIT}). Pure pipelines must return a new state/patch object or encapsulate state transitions inside an owning SubController.`
        );
      }
    }
  }

  if (hasExportedClass && !isPipelineOrMath) {
    const aliasMap = new Map<string, string>();

    const directAliasRegex =
      /\b(?:const|let)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*this\.([a-zA-Z_$][a-zA-Z0-9_$]*(?:\.[a-zA-Z_$][a-zA-Z0-9_$]*)?)\s*;/g;
    let aliasMatch: RegExpExecArray | null;
    while ((aliasMatch = directAliasRegex.exec(codeWithoutComments)) !== null) {
      aliasMap.set(aliasMatch[1], `this.${aliasMatch[2]}`);
    }

    const destructAliasRegex =
      /\b(?:const|let)\s*\{([^}]+)\}\s*=\s*this(?:\.([a-zA-Z_$][a-zA-Z0-9_$]*))?\s*;/g;
    let destructMatch: RegExpExecArray | null;
    while ((destructMatch = destructAliasRegex.exec(codeWithoutComments)) !== null) {
      const prefix = destructMatch[2] ? `this.${destructMatch[2]}` : 'this';
      for (const rawItem of destructMatch[1].split(',')) {
        const parts = rawItem.split(':').map((s) => s.trim());
        const propName = parts[0];
        const localName = parts[parts.length - 1];
        if (propName && localName && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(localName)) {
          aliasMap.set(localName, `${prefix}.${propName}`);
        }
      }
    }

    const isExternalControllerOrStateTarget = (target: string): boolean => {
      const lower = target.toLowerCase();
      if (
        lower.startsWith('this._scratch') ||
        lower.startsWith('this.currentevent') ||
        lower.startsWith('this.controls') ||
        lower.startsWith('this.settings') ||
        lower.startsWith('this.primarypose') ||
        lower.startsWith('this._originalmethods')
      ) {
        return false;
      }
      return (
        lower.includes('ctrl') ||
        lower.includes('controller') ||
        lower.includes('coordinator') ||
        lower.includes('domain') ||
        lower.includes('channel') ||
        lower.includes('host') ||
        lower.includes('runtime') ||
        lower.includes('reconciler') ||
        lower.includes('sessionstate') ||
        lower.includes('directorcamerastate') ||
        lower.includes('mode') ||
        lower.includes('simulator') ||
        lower.includes('metrics') ||
        lower.includes('sampler') ||
        lower.includes('goalandtouch') ||
        lower.includes('directorpreview') ||
        lower.includes('latch')
      );
    };

    const classMutatedByTarget = new Map<string, Set<string>>();

    const memberMutRegex =
      /\b(this\.[a-zA-Z_$][a-zA-Z0-9_$]*(?:\.[a-zA-Z_$][a-zA-Z0-9_$]*)?)\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?:=(?!=)|[+\-*/%&|^]=|\+\+|--)/g;
    let mMut: RegExpExecArray | null;
    while ((mMut = memberMutRegex.exec(codeWithoutComments)) !== null) {
      const target = mMut[1];
      const prop = mMut[2];
      if (isGraphicsOrDomTarget(target)) continue;
      if (!isExternalControllerOrStateTarget(target)) continue;
      if (!classMutatedByTarget.has(target)) {
        classMutatedByTarget.set(target, new Set());
      }
      classMutatedByTarget.get(target)!.add(prop);
    }

    const identMutRegex =
      /(?<!\.)\b([a-zA-Z_$][a-zA-Z0-9_$]*)\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?:=(?!=)|[+\-*/%&|^]=|\+\+|--)/g;
    let iMut: RegExpExecArray | null;
    while ((iMut = identMutRegex.exec(codeWithoutComments)) !== null) {
      const ident = iMut[1];
      const prop = iMut[2];
      if (ident === 'this' || ALLOWED_LOCAL_BUFFER_NAMES.has(ident)) continue;
      const resolvedTarget = aliasMap.get(ident) || ident;
      if (isGraphicsOrDomTarget(resolvedTarget)) continue;
      if (!isExternalControllerOrStateTarget(resolvedTarget)) continue;
      if (!classMutatedByTarget.has(resolvedTarget)) {
        classMutatedByTarget.set(resolvedTarget, new Set());
      }
      classMutatedByTarget.get(resolvedTarget)!.add(prop);
    }

    for (const [target, props] of classMutatedByTarget.entries()) {
      if (props.size > CROSS_CONTROLLER_MUTATION_LIMIT) {
        const sampleProps = [...props].sort().slice(0, 6).join(', ');
        errors.push(
          `[CROSS-CONTROLLER GUT-SHARING] ${rel} directly mutates ${props.size} properties on '${target}' (${sampleProps}${props.size > 6 ? ', ...' : ''}; limit: ${CROSS_CONTROLLER_MUTATION_LIMIT}). Encapsulate state mutations inside the owning class via narrow domain methods.`
        );
      }
    }

    const classReadByTarget = new Map<string, Set<string>>();
    const isPortTarget = (target: string): boolean => {
      const lower = target.toLowerCase();
      return (
        lower === 'this.host' ||
        lower === 'this.runtime' ||
        lower === 'this.channel' ||
        lower === 'this.domain' ||
        lower.startsWith('this.host.') ||
        lower.startsWith('this.deps.') ||
        lower.endsWith('ctrl') ||
        lower.endsWith('controller')
      );
    };

    const memberReadRegex =
      /\b(this\.[a-zA-Z_$][a-zA-Z0-9_$]*(?:\.[a-zA-Z_$][a-zA-Z0-9_$]*)?)\.([a-zA-Z_$][a-zA-Z0-9_$]*)/g;
    let mRead: RegExpExecArray | null;
    while ((mRead = memberReadRegex.exec(codeWithoutComments)) !== null) {
      const target = mRead[1];
      const prop = mRead[2];
      if (!isPortTarget(target)) continue;
      if (!classReadByTarget.has(target)) {
        classReadByTarget.set(target, new Set());
      }
      classReadByTarget.get(target)!.add(prop);
    }

    const identReadRegex = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\.([a-zA-Z_$][a-zA-Z0-9_$]*)/g;
    let iRead: RegExpExecArray | null;
    while ((iRead = identReadRegex.exec(codeWithoutComments)) !== null) {
      const ident = iRead[1];
      const prop = iRead[2];
      if (ident === 'this') continue;
      const resolvedTarget = aliasMap.get(ident) || ident;
      if (!isPortTarget(resolvedTarget)) continue;
      if (!classReadByTarget.has(resolvedTarget)) {
        classReadByTarget.set(resolvedTarget, new Set());
      }
      classReadByTarget.get(resolvedTarget)!.add(prop);
    }

    for (const [target, props] of classReadByTarget.entries()) {
      if (props.size > WIDE_WAIST_PORT_READ_LIMIT) {
        const sampleProps = [...props].sort().slice(0, 6).join(', ');
        errors.push(
          `[WIDE-WAIST PORT VIOLATION] ${rel} accesses ${props.size} distinct properties on external port '${target}' (${sampleProps}${props.size > 6 ? ', ...' : ''}; limit: ${WIDE_WAIST_PORT_READ_LIMIT}). Narrow the port contract or move cohesive domain logic into the owning controller.`
        );
      }
    }
  }
}
