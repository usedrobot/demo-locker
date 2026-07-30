// Strip server-only fields from a track row before it goes to a client, the
// same way publicComment() strips deleteToken.
//
// originalKey/streamKey are bucket coordinates. Handing them to every client
// with read access — including listen-only share holders — published the
// storage layout and gave anyone who kept a copy a durable handle on the
// object, which is half of what made the artworkKey read primitive exploitable.
// Nothing outside the API ever needed the values: the web client only asked
// "is there a stream yet", which `hasStream` answers.

export type PublicTrack = Omit<
  Record<string, unknown>,
  "originalKey" | "streamKey"
> & { hasStream: boolean };

export function publicTrack<T extends Record<string, unknown>>(row: T): PublicTrack {
  const { originalKey: _originalKey, streamKey, ...rest } = row;
  return { ...rest, hasStream: streamKey != null };
}
