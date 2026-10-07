// Failure classifier. Pure function — same inputs, same output.
// Decides why a meeting ended based on observed signals.

export type FailureReason =
  | 'GOOGLE_AUTH_REQUIRED'
  | 'MEETING_ENDED'
  | 'REMOVED_FROM_MEETING'
  | 'CANNOT_JOIN'
  | 'BROWSER_CRASHED'
  | 'FFMPEG_FAILED'
  | 'WEBRTC_DISCONNECTED'
  | 'PAGE_ERROR'
  | 'ABORTED'
  | 'UNKNOWN_FAILURE';

export interface ClassifyInput {
  url?: string;
  title?: string;
  matchedSelector?: string;        // text/label that the poll loop matched
  matchedGroup?: 'ended' | 'auth' | 'removed' | 'reconnecting' | 'cannotJoin';
  ffmpegExit?: { code: number | null; signal: string | null };
  browserDisconnected?: boolean;
  pageError?: { message: string };
  aborted?: boolean;
}

export interface ClassifyOutput {
  reason: FailureReason;
  detail: string;
}

const accountsUrl = (u: string) => /(^|\.)accounts\.google\.com$/i.test(new URL(u).hostname);

export function classifyEndSignal(input: ClassifyInput): ClassifyOutput {
  if (input.aborted) {
    return { reason: 'ABORTED', detail: 'user aborted the job' };
  }
  if (input.browserDisconnected) {
    return { reason: 'BROWSER_CRASHED', detail: 'browser disconnected unexpectedly' };
  }
  if (input.ffmpegExit && (input.ffmpegExit.code !== 0 || input.ffmpegExit.signal)) {
    return {
      reason: 'FFMPEG_FAILED',
      detail: `ffmpeg exited code=${input.ffmpegExit.code} signal=${input.ffmpegExit.signal ?? 'none'}`,
    };
  }
  if (input.pageError) {
    return { reason: 'PAGE_ERROR', detail: input.pageError.message.slice(0, 200) };
  }
  if (input.url && accountsUrl(input.url)) {
    return {
      reason: 'GOOGLE_AUTH_REQUIRED',
      detail: `navigated to ${input.url}`,
    };
  }
  switch (input.matchedGroup) {
    case 'auth':
      return {
        reason: 'GOOGLE_AUTH_REQUIRED',
        detail: `auth-required indicator matched: ${input.matchedSelector ?? 'unknown'}`,
      };
    case 'removed':
      return {
        reason: 'REMOVED_FROM_MEETING',
        detail: `removed indicator matched: ${input.matchedSelector ?? 'unknown'}`,
      };
    case 'reconnecting':
      return {
        reason: 'WEBRTC_DISCONNECTED',
        detail: `reconnecting indicator matched: ${input.matchedSelector ?? 'unknown'}`,
      };
    case 'cannotJoin':
      return {
        reason: 'CANNOT_JOIN',
        detail: `cannot-join indicator matched: ${input.matchedSelector ?? 'unknown'}`,
      };
    case 'ended':
      return {
        reason: 'MEETING_ENDED',
        detail: `end indicator matched: ${input.matchedSelector ?? 'unknown'}`,
      };
    default:
      return {
        reason: 'UNKNOWN_FAILURE',
        detail: `no matched signal url=${input.url ?? ''} title=${input.title ?? ''}`,
      };
  }
}

// Used by `waitForMeetingEnd` to choose which selector group matched.
export type SelectorGroup = 'ended' | 'auth' | 'removed' | 'reconnecting' | 'cannotJoin';

export function groupForSelector(matchedText: string): SelectorGroup | null {
  const s = matchedText.toLowerCase();
  if (
    s.includes('you left the meeting') ||
    s.includes('meeting ended') ||
    s.includes('return to home screen') ||
    s.includes("you're the only one here") ||
    s.includes('the call has ended') ||
    s.includes('the meeting has ended')
  ) return 'ended';
  if (
    s.includes('you were removed') ||
    s.includes('you have been removed') ||
    s.includes('someone removed you') ||
    s.includes('kicked from the call')
  ) return 'removed';
  if (s.includes('sign in') || s.includes('sign-in')) return 'auth';
  if (s.includes("can't join") || s.includes('cannot join') || s.includes('not available')) return 'cannotJoin';
  if (s.includes('reconnecting') || s.includes('trying to reconnect')) return 'reconnecting';
  return null;
}