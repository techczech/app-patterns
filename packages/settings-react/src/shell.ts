/** The one encoder for every dynamic argument in a command the user copies into a shell. */

/** Letters, digits and `@%+=:,./-` need no quoting in a POSIX shell. */
const PLAIN = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** One POSIX shell word: plain text as it is, anything else in single quotes with `'` written as `'\''`. */
export function shellArg(s: string): string {
  return PLAIN.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

/** A file in the Downloads folder: the `~/Downloads/` is left outside the quotes so the shell expands it, the file name is quoted. */
export const downloadsPath = (fileName: string): string => `~/Downloads/${shellArg(fileName)}`;
