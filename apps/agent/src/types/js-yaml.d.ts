// Minimal types for the part of js-yaml the deployment tests use.
declare module "js-yaml" {
  export function load(input: string): unknown;
  export function loadAll(input: string): unknown[];
}
