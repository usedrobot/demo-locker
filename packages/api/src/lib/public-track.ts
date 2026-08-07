// Strip server-only fields from a track row before it goes to a client, the
// same way publicComment() strips deleteToken.
//
// originalKey/streamKey are bucket coordinates. Handing them to every client
// with read access — including listen-only share holders — published the
// storage layout and gave anyone who kept a copy a durable handle on the
// object, which is half of what made the artworkKey read primitive exploitable.
// Nothing outside the API ever needed the values: the web client only asked
// "is there a stream yet", which `hasStream` answers.
//
// uploadedBy is stripped for the same reason: it's an internal user UUID,
// and publicTrack() is the seam every reader shares — including anonymous
// listen-share holders, who should never learn a collaborator's id just by
// viewing a playlist. Nothing in the UI shows attribution yet; a future
// feature that wants it should expose it deliberately on a locker-scoped
// response, not leak it here by default.

export type PublicTrack = Omit<
  Record<string, unknown>,
  "originalKey" | "streamKey" | "uploadedBy"
> & { hasStream: boolean };

export function publicTrack<T extends Record<string, unknown>>(row: T): PublicTrack {
  const {
    originalKey: _originalKey,
    streamKey,
    uploadedBy: _uploadedBy,
    ...rest
  } = row;
  return { ...rest, hasStream: streamKey != null };
}
