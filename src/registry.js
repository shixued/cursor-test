export const registeredModules = {
  plugins: new Set(),
  editors: new Set(),
  renderers: new Set(),
  validators: new Set(),
};

export function registerPlugin(plugin) {
  if (plugin) registeredModules.plugins.add(plugin);
}

export function registerEditor(editor) {
  if (editor) registeredModules.editors.add(editor);
}

export function registerRenderer(renderer) {
  if (renderer) registeredModules.renderers.add(renderer);
}

export function registerValidator(validator) {
  if (validator) registeredModules.validators.add(validator);
}

export function registerAllModules() {
  // Compatibility no-op: included so existing Handsontable bootstrap
  // code can be kept when swapping to this canvas implementation.
  return registeredModules;
}
