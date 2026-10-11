/**
 * Returns the word with its first letter in upper case.
 * @param {string} word
 * @returns {string}
 */
export function capitalize(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Returns true when the value is null, undefined or an empty string.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isBlank(value) {
  return value === null || value === undefined || value === "";
}
