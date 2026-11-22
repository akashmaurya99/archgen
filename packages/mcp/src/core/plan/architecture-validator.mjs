// Structural validation for architecture.yaml, before cross-file audit rules.
import { basename } from 'node:path';
import { isSlug } from '../protocol/slug.mjs';
import { globsMayOverlap } from './graph.mjs';

const mapping = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const stringList = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');

/** Return deterministic CONFIG_INVALID / MODULE_OVERLAP findings. */
export function validateArchitecture(architecture, slugDir) {
  if (architecture === null || architecture === undefined) return [];
  const issues = [];
  const invalid = (message) => issues.push(`CONFIG_INVALID: ${message}`);
  if (!mapping(architecture)) return ['CONFIG_INVALID: architecture.yaml must contain a mapping'];

  if (architecture.name === undefined) issues.push('CONFIG_REQUIRED: name is required for new architecture contracts');
  else if (typeof architecture.name !== 'string' || !architecture.name.trim()) invalid('name must be a non-empty string');
  if (architecture.slug === undefined) issues.push('CONFIG_REQUIRED: slug is required for new architecture contracts');
  else if (typeof architecture.slug !== 'string' || !isSlug(architecture.slug)) {
    invalid('slug must be a lowercase dash-separated path segment');
  } else if (architecture.slug !== basename(slugDir)) {
    invalid(`slug '${architecture.slug}' must match the artifact folder '${basename(slugDir)}'`);
  }
  if (architecture.toolchain === undefined) issues.push('CONFIG_REQUIRED: toolchain is required for new architecture contracts');
  else if (!mapping(architecture.toolchain)) invalid('toolchain must be a mapping');
  else {
    for (const [key, value] of Object.entries(architecture.toolchain)) {
      if (typeof value !== 'string' || !value.trim()) invalid(`toolchain.${key} must be a non-empty string`);
    }
    const source = architecture.toolchain.source_root;
    const test = architecture.toolchain.test_root;
    if (source && test && source.replace(/^\.\//, '').replace(/\/$/, '') === test.replace(/^\.\//, '').replace(/\/$/, '')) {
      invalid('toolchain.source_root and toolchain.test_root must name different roots');
    }
  }

  if (architecture.structure === undefined) issues.push('CONFIG_REQUIRED: structure[] is required for new architecture contracts');
  else if (!Array.isArray(architecture.structure)) {
    invalid('structure must be a sequence of {path,purpose} mappings, not a string or scalar');
  } else {
    architecture.structure.forEach((entry, index) => {
      if (!mapping(entry) || typeof entry.path !== 'string' || !entry.path.trim() || typeof entry.purpose !== 'string' || !entry.purpose.trim()) {
        invalid(`structure[${index}] must contain non-empty string path and purpose fields`);
      }
    });
  }

  if (architecture.modules === undefined) issues.push('CONFIG_REQUIRED: modules[] is required for new architecture contracts');
  else if (!Array.isArray(architecture.modules)) {
    invalid('modules must be a sequence of module mappings');
  } else {
    const owners = [];
    architecture.modules.forEach((entry, index) => {
      if (!mapping(entry) || typeof entry.name !== 'string' || !entry.name.trim() || typeof entry.responsibility !== 'string') {
        invalid(`modules[${index}] must contain non-empty name and responsibility strings`);
        return;
      }
      if (!stringList(entry.owns)) invalid(`modules[${index}].owns must be a sequence of glob strings`);
      if (!stringList(entry.depends_on_modules)) invalid(`modules[${index}].depends_on_modules must be a sequence of module names`);
      if (!stringList(entry.key_interfaces)) invalid(`modules[${index}].key_interfaces must be a sequence of strings`);
      for (const glob of Array.isArray(entry.owns) ? entry.owns : []) {
        for (const previous of owners) {
          if (globsMayOverlap(previous.glob, glob)) {
            issues.push(`MODULE_OVERLAP: module '${previous.module}' owns '${previous.glob}', which overlaps module '${entry.name}' owning '${glob}'`);
          }
        }
        owners.push({ module: entry.name, glob });
      }
    });
  }

  const moduleNames = new Set();
  if (Array.isArray(architecture.modules)) {
    for (const [index, entry] of architecture.modules.entries()) {
      if (!mapping(entry) || typeof entry.name !== 'string' || !entry.name.trim()) continue;
      if (moduleNames.has(entry.name)) invalid(`modules[${index}] duplicates module name '${entry.name}'`);
      moduleNames.add(entry.name);
    }
    for (const [index, entry] of architecture.modules.entries()) {
      if (!mapping(entry)) continue;
      for (const dependency of Array.isArray(entry.depends_on_modules) ? entry.depends_on_modules : []) {
        if (!moduleNames.has(dependency)) invalid(`modules[${index}].depends_on_modules names unknown module '${dependency}'`);
      }
    }
    // Kahn elimination validates the module DAG without recursion on untrusted depth.
    // Keep entries (not a name-keyed map): duplicate names are reported above
    // and must not hide a cycle between the original entries.
    const remaining = architecture.modules.filter(mapping).map((entry) => ({
      name: entry.name,
      dependencies: Array.isArray(entry.depends_on_modules) ? entry.depends_on_modules : [],
    }));
    while (remaining.length) {
      const ready = remaining.findIndex((entry) => entry.dependencies.every((dependency) => !remaining.some((other) => other.name === dependency)));
      if (ready < 0) {
        invalid(`modules[].depends_on_modules contains a cycle involving '${remaining.map((entry) => entry.name).join(', ')}'`);
        break;
      }
      remaining.splice(ready, 1);
    }
  }

  if (architecture.existing_docs !== undefined) {
    if (!Array.isArray(architecture.existing_docs)) invalid('existing_docs must be a sequence of document mappings');
    else architecture.existing_docs.forEach((entry, index) => {
      if (!mapping(entry) || typeof entry.path !== 'string' || !entry.path.trim()) invalid(`existing_docs[${index}] must contain a non-empty path`);
      if (mapping(entry) && !['prd', 'architecture', 'adr', 'readme'].includes(entry.kind)) invalid(`existing_docs[${index}].kind must be prd|architecture|adr|readme`);
      if (mapping(entry) && !['current', 'stale'].includes(entry.status)) invalid(`existing_docs[${index}].status must be current|stale`);
    });
  }

  if (architecture.naming_conventions !== undefined) {
    if (!mapping(architecture.naming_conventions)) invalid('naming_conventions must be a mapping of strings');
    else for (const [key, value] of Object.entries(architecture.naming_conventions)) {
      if (typeof value !== 'string' || !value.trim()) invalid(`naming_conventions.${key} must be a non-empty string`);
    }
  }

  if (architecture.data_contracts !== undefined) {
    if (!mapping(architecture.data_contracts)) invalid('data_contracts must be a mapping by entity');
    else for (const [entity, contract] of Object.entries(architecture.data_contracts)) {
      if (!mapping(contract) || typeof contract.storage !== 'string' || !Array.isArray(contract.fields)) {
        invalid(`data_contracts.${entity} must contain storage and fields[]`);
        continue;
      }
      contract.fields.forEach((field, index) => {
        if (!mapping(field) || typeof field.field !== 'string' || typeof field.type !== 'string' || typeof field.required !== 'boolean') {
          invalid(`data_contracts.${entity}.fields[${index}] must contain string field/type and boolean required`);
        }
        if (mapping(field) && field.notes !== undefined && typeof field.notes !== 'string') invalid(`data_contracts.${entity}.fields[${index}].notes must be a string`);
      });
    }
  }

  if (architecture.api_contracts !== undefined) {
    if (!mapping(architecture.api_contracts)) invalid('api_contracts must be a mapping of operation sequences');
    else for (const [module, operations] of Object.entries(architecture.api_contracts)) {
      if (!Array.isArray(operations)) { invalid(`api_contracts.${module} must be a sequence`); continue; }
      operations.forEach((operation, index) => {
        if (!mapping(operation) || typeof operation.endpoint !== 'string' || typeof operation.auth !== 'string') {
          invalid(`api_contracts.${module}[${index}] must contain string endpoint and auth fields`);
          return;
        }
        if (!mapping(operation.request_payload)) invalid(`api_contracts.${module}[${index}].request_payload must be a mapping`);
        if (typeof operation.success !== 'string') invalid(`api_contracts.${module}[${index}].success must be a string`);
        if (!mapping(operation.error_shape) || ['code', 'message', 'retryable'].some((key) => typeof operation.error_shape[key] !== 'string')) {
          invalid(`api_contracts.${module}[${index}].error_shape must contain string code/message/retryable types`);
        }
      });
    }
  }

  if (architecture.environment_matrix !== undefined) {
    if (!Array.isArray(architecture.environment_matrix)) invalid('environment_matrix must be a sequence of environment mappings');
    else architecture.environment_matrix.forEach((entry, index) => {
      if (!mapping(entry) || ['var', 'dev', 'ci', 'prod'].some((key) => typeof entry[key] !== 'string') || typeof entry.required !== 'boolean') {
        invalid(`environment_matrix[${index}] must contain string var/dev/ci/prod and boolean required`);
      }
    });
  }

  if (architecture.decisions !== undefined) {
    if (!Array.isArray(architecture.decisions)) invalid('decisions must be a sequence of ADR index mappings');
    else {
      const ids = new Set();
      architecture.decisions.forEach((entry, index) => {
        if (!mapping(entry) || typeof entry.id !== 'string' || typeof entry.title !== 'string') {
          invalid(`decisions[${index}] must contain string id and title fields`);
          return;
        }
        if (ids.has(entry.id)) invalid(`decisions[${index}] duplicates decision id '${entry.id}'`);
        ids.add(entry.id);
        for (const key of ['context', 'decision']) {
          if (entry[key] !== undefined && typeof entry[key] !== 'string') invalid(`decisions[${index}].${key} must be a string`);
        }
        if (entry.consequences !== undefined && !stringList(entry.consequences)) {
          invalid(`decisions[${index}].consequences must be a sequence of strings`);
        }
      });
    }
  }
  return issues;
}
