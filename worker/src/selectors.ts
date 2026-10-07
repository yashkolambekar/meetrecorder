// Meet UI selectors. Google ships UI changes that break these — fix in this one file.
// Where the UI has multiple variants (e.g., different button labels), we expose
// candidate lists so the worker tries each in order.
//
// Grouped into lifecycle phases. New selectors added during the persistent-profile
// refactor are tagged `/* new */` so we can audit what changed.

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
  ':text("You\'re the only one here")',         /* new */
  ':text("The meeting has ended")',             /* new */
  ':text("The call has ended")',                /* new */
];

export const googleAuthRequiredCandidates = [                       /* new */
  'input[type="email"]',
  '[data-identifier="identifierId"]',
  ':text("Sign in to continue to Meet")',
  ':text("Sign in to continue")',
  ':text("Sign in")',
];

export const reconnectingCandidates = [                             /* new */
  ':text("Reconnecting")',
  ':text("Trying to reconnect")',
];

export const removedFromMeetingCandidates = [                       /* new */
  ':text("You were removed")',
  ':text("You have been removed")',
  ':text("Someone removed you from the call")',
];

export const cantJoinCandidates = [                                 /* new */
  ':text("You can\'t join this meeting")',
  ':text("You need a Google Account")',
  ':text("This meeting is not available")',
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
  'label:has-text("Spotlight")',
  'input[type="radio"][name="preferences"][value="mvZqyf"]',
  '[role="radio"]:has-text("Spotlight")',
  '[role="menuitemradio"]:has-text("Spotlight")',
  '[role="menuitem"]:has-text("Spotlight")',
];

export const dialogCloseButtonCandidates = [
  'button[aria-label="Close"]',
  '[role="dialog"] button[aria-label="Close"]',
  'button:has(i.google-symbols:text("close"))',
];

// Profile readiness indicators on myaccount.google.com / accounts.google.com.
export const profileReadyCandidates = [                             /* new */
  'img[alt*="Profile" i]',
  'a[aria-label*="Google Account" i]',
  '[data-profile-photo]',
  '[aria-label*="Account" i][role="button"]',
  'button[aria-label*="Google Account" i]',
];

export const profileSignedInIndicators = [                          /* new */
  ':text("Welcome")',
  ':text("Your account")',
];

// Selector groups, in priority order, used by the poll loop.
export const failureSelectorGroups: Array<{
  group: 'auth' | 'removed' | 'reconnecting' | 'cannotJoin' | 'ended';
  candidates: string[];
}> = [
  { group: 'auth',         candidates: googleAuthRequiredCandidates },
  { group: 'removed',      candidates: removedFromMeetingCandidates },
  { group: 'cannotJoin',   candidates: cantJoinCandidates },
  { group: 'reconnecting', candidates: reconnectingCandidates },
  { group: 'ended',        candidates: meetingEndedCandidates },
];