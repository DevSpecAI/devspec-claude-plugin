/**
 * Shell escaping utilities for safe command generation
 */
/**
 * Escape a string for safe embedding in a single-quoted bash string.
 * Single quotes in bash prevent all expansion, making this the safest approach.
 *
 * Examples:
 *   shellEscape('foo')     -> "'foo'"
 *   shellEscape("it's")    -> "'it'\\''s'"
 *   shellEscape('$HOME')   -> "'$HOME'" (no expansion)
 *   shellEscape('"; rm -rf /') -> "'\"'; rm -rf /'"
 *
 * The technique: wrap in single quotes, escape any internal single quotes
 * by ending the string, adding an escaped quote, and starting a new string.
 * 'it'\''s' = 'it' + \' + 's' = it's
 */
export declare function shellEscape(str: string): string;
/**
 * Sanitize a string to contain only safe characters for display in comments.
 * Removes shell metacharacters and control characters while preserving
 * common punctuation used in task names.
 */
export declare function sanitizeForComment(str: string): string;
/**
 * Validate that a string matches a safe identifier pattern
 */
export declare function isSafeIdentifier(str: string, pattern: RegExp): boolean;
export declare const GIT_REF_PATTERN: RegExp;
export declare const GIT_REMOTE_PATTERN: RegExp;
export declare const SAFE_PATH_PATTERN: RegExp;
//# sourceMappingURL=shell.d.ts.map