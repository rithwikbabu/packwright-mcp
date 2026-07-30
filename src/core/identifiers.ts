import { PackwrightError } from './errors.js';

const NAMESPACE = /^[a-z0-9._-]+$/u;
const RESOURCE_PATH = /^[a-z0-9._/-]+$/u;

export interface ResourceIdentifier {
  namespace: string;
  path: string;
}

export function isValidNamespace(value: string): boolean {
  return NAMESPACE.test(value);
}

export function isValidResourcePath(value: string): boolean {
  return (
    RESOURCE_PATH.test(value) &&
    !value.startsWith('/') &&
    !value.endsWith('/') &&
    !value.includes('//') &&
    value.split('/').every((part) => part !== '.' && part !== '..')
  );
}

export function parseResourceId(value: string): ResourceIdentifier {
  const separator = value.indexOf(':');
  if (separator <= 0 || separator !== value.lastIndexOf(':')) {
    throw new PackwrightError(
      'invalid_resource_id',
      `Resource identifier must have the form namespace:path: ${value}`,
    );
  }
  const namespace = value.slice(0, separator);
  const resourcePath = value.slice(separator + 1);
  if (!isValidNamespace(namespace) || !isValidResourcePath(resourcePath)) {
    throw new PackwrightError('invalid_resource_id', `Invalid resource identifier: ${value}`);
  }
  return { namespace, path: resourcePath };
}

export function isValidResourceId(value: string): boolean {
  try {
    parseResourceId(value);
    return true;
  } catch {
    return false;
  }
}
