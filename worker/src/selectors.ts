// Meet UI selectors. Google ships UI changes that break these — fix in this one file.
// Where the UI has multiple variants (e.g. different button labels), we expose
// candidate lists so the worker tries each in order.

export const acceptCookiesCandidates = [
  'button:has-text("Accept all")',
  'button:has-text("I agree")',
  'button:has-text("Reject all")',
];

export const nameInputCandidates = [
  'input[aria-label*="name" i]',
  'input[aria-label*="Name" i]',
  'input[placeholder*="name" i]',
  'input[placeholder*="Name" i]',
];

export const cameraToggleCandidates = [
  '[aria-label*="camera" i][role="button"]',
  'button[aria-label*="camera" i]',
];

export const micToggleCandidates = [
  '[aria-label*="microphone" i][role="button"]',
  'button[aria-label*="microphone" i]',
];

export const askToJoinCandidates = [
  'button:has-text("Ask to join")',
  'button:has-text("Join now")',
  'button:has-text("Join a meeting")',
  'button:has-text("Join")',
];

export const inCallCandidates = [
  '[aria-label*="leave call" i]',
  'button[aria-label*="leave" i]',
  '[data-meeting-title]',
  '[data-call-active]',
];

export const meetingEndedCandidates = [
  ':text("You left the meeting")',
  ':text("Meeting ended")',
  ':text("Return to home screen")',
];

// Layout menu (post-join) — current Meet UI puts it under
// "More options" (3-dot) → "Adjust view" → Spotlight.
export const moreOptionsButtonCandidates = [
  'button[aria-label="More options"]',
  '[aria-label="More options"][role="button"]',
];

export const adjustViewMenuItemCandidates = [
  '[role="menuitem"]:has-text("Adjust view")',
  '[role="menuitem"]:has-text("Change layout")',
  '[role="menuitem"]:has-text("Layout")',
];

export const spotlightOptionCandidates = [
  // The current "Adjust view" panel uses real <input type="radio"> inside
  // <label class="DxvcU"> wrappers — not menuitemradio.
  'label:has-text("Spotlight")',
  'input[type="radio"][name="preferences"][value="mvZqyf"]',
  '[role="radio"]:has-text("Spotlight")',
  '[role="menuitemradio"]:has-text("Spotlight")',
  '[role="menuitem"]:has-text("Spotlight")',
];

// The "Adjust view" dialog has an X button at the top-right. Close it after
// picking a layout so it doesn't sit on top of the screen-share for the
// rest of the recording.
export const dialogCloseButtonCandidates = [
  'button[aria-label="Close"]',
  '[role="dialog"] button[aria-label="Close"]',
  'button:has(i.google-symbols:text("close"))',
];