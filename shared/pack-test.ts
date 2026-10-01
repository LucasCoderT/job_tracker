/**
 * The pack test: does a tailored CV and cover letter get more replies than his
 * base CV alone?
 *
 * Set up 2026-10-01. From 2026-09-16 every application went out with a pack the
 * Mac built, and over the same weeks replies fell to roughly a third of June's
 * rate. Better tooling and fewer replies arrived together, and nothing could
 * say which caused which, so half the postings now go out with the base CV and
 * no letter.
 *
 * Shared by the Worker and the browser so the brief, the listing's bulk build
 * and the route that refuses a build all agree on which half a posting is in.
 */

export type PackArm = 'tailored' | 'base'

/**
 * Which half a posting is in, from its id. The id is the first 16 hex of a
 * sha256, so its last digit is as good as a coin and cannot be steered: the
 * usual way a test like this misleads is the strongest postings quietly
 * getting the tailored treatment.
 */
export function packArm(id: string): PackArm {
  return parseInt(String(id).slice(-1), 16) % 2 === 0 ? 'tailored' : 'base'
}

/**
 * Whether the test decides this posting's pack. Only while the test is running
 * (a base CV exists), and only for a posting with nothing built or asked for
 * yet and not yet sent: a pack already built before the test is sunk cost, and
 * an applied posting has already been sent with something.
 */
export function inPackTest(
  meta: { id: string; state: string; pack: string },
  test: { startedAt: string | null } | null,
): boolean {
  return !!test?.startedAt && meta.state === 'new' && meta.pack === 'none'
}

/** What an application actually went out with, read off the posting when it is marked applied. */
export function sentWith(meta: { pack: string }): PackArm {
  return meta.pack === 'done' ? 'tailored' : 'base'
}
