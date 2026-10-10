/**
 * Full-page navigation, for leaving the app shell (sign-in and sign-out).
 * Kept in its own module so tests can observe it: jsdom does not navigate.
 */
export function navigateTo(url: string): void {
  window.location.assign(url);
}
