import { z } from 'zod';

export const urlValidator = z
  .string({ required_error: 'long_url is required' })
  .superRefine((raw, ctx) => {
    // 1. Reject illegal control characters on raw untrimmed string (CR, LF, TAB, null bytes, etc.)
    if (/[\r\n\t\x00-\x1F\x7F]/.test(raw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'URL contains illegal control characters',
      });
      return;
    }

    const trimmed = raw.trim();

    // 2. Reject empty or oversized input
    if (trimmed.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'URL cannot be empty',
      });
      return;
    }

    if (trimmed.length > 2048) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'URL exceeds 2048 characters',
      });
      return;
    }

    // 3. Reject backslash smuggling (e.g. http:\\evil.example.com)
    if (trimmed.includes('\\')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'URL must not contain backslashes',
      });
      return;
    }

    // 4. Must match explicit http:// or https:// prefix directly
    if (!/^https?:\/\//i.test(trimmed)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'URL must start with http:// or https://',
      });
      return;
    }

    // 5. Structural WHATWG URL parsing
    try {
      const parsed = new URL(trimmed);

      // Verify protocol allowlist
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Only http and https protocols are permitted',
        });
        return;
      }

      // Reject userinfo authentication tricks (e.g. https://good.com@evil.example.com)
      if (parsed.username || parsed.password) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'URL credentials/userinfo are not permitted',
        });
        return;
      }

      // Verify hostname
      if (!parsed.hostname || (!parsed.hostname.includes('.') && parsed.hostname !== 'localhost')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'URL must have a valid hostname',
        });
        return;
      }
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid URL format',
      });
    }
  });

export const createLinkSchema = z
  .object({
    long_url: urlValidator.optional(),
    longUrl: urlValidator.optional(),
    expires_at: z
      .string()
      .datetime({ message: 'expires_at must be an ISO-8601 datetime string' })
      .optional()
      .refine((val) => !val || new Date(val) > new Date(), {
        message: 'expires_at must be in the future',
      }),
    expiresAt: z
      .string()
      .datetime({ message: 'expiresAt must be an ISO-8601 datetime string' })
      .optional()
      .refine((val) => !val || new Date(val) > new Date(), {
        message: 'expiresAt must be in the future',
      }),
    tags: z
      .array(z.string().trim().min(1, 'Tag cannot be empty').max(30, 'Tag exceeds 30 characters'))
      .max(10, 'Cannot exceed 10 tags')
      .optional(),
  })
  .refine((data) => data.long_url || data.longUrl, {
    message: 'long_url is required',
    path: ['long_url'],
  });

export type CreateLinkInput = z.infer<typeof createLinkSchema>;

export const listLinksQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type ListLinksQuery = z.infer<typeof listLinksQuerySchema>;

export const updateLinkSchema = z.object({
  long_url: urlValidator.optional(),
  longUrl: urlValidator.optional(),
  expires_at: z
    .string()
    .datetime({ message: 'expires_at must be an ISO-8601 datetime string' })
    .optional()
    .refine((val) => !val || new Date(val) > new Date(), {
      message: 'expires_at must be in the future',
    }),
  tags: z
    .array(z.string().trim().min(1, 'Tag cannot be empty').max(30, 'Tag exceeds 30 characters'))
    .max(10, 'Cannot exceed 10 tags')
    .optional(),
});

export type UpdateLinkInput = z.infer<typeof updateLinkSchema>;

export const searchLinksQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  tag: z.string().trim().max(50).optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce
    .number()
    .int()
    .min(1)
    .max(100, { message: 'page_size cannot exceed 100' })
    .default(20),
  sort_by: z.enum(['created_at', 'expires_at', 'clicks']).default('created_at'),
  sort_order: z.enum(['asc', 'desc']).default('desc'),
});

export type SearchLinksQuery = z.infer<typeof searchLinksQuerySchema>;
