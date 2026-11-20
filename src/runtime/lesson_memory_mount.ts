/**
 * cap_lesson_memory_mount_39 — principal-scoped durable lessons.
 *
 * Cross-run experiential memory. Lessons are untrusted historical hypotheses,
 * not instructions, weight updates, or demonstrated improvement.
 *
 * Durability: same-directory O_EXCL temp, file fsync, exclusive link (no replace),
 * O_NOFOLLOW digest re-read, directory fsync reported unsupported rather than claimed.
 * Per-principal POSIX flock covers authorize-and-publish. Locks are never stolen by age.
 */
import { createHash, randomBytes } from 