/**
 * Test environment shims.
 *
 * jsdom implements the DOM but not layout, so anything that scrolls or
 * measures is missing. These are stubs for browser APIs that exist in every
 * real browser — not workarounds for application bugs, and nothing here should
 * ever paper over a genuine failure.
 */

// Components scroll a conversation to the newest message on mount.
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? function () {};

// Used by any code that measures before animating.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
