/**
 * Parse a smoke response without hiding cancellation. Provider/API error
 * bodies may legitimately be non-JSON, but a caller/deadline abort must keep
 * rejecting so the cancellation proof cannot turn into a normal null body.
 */
export async function readJsonOrNull(response, signal) {
  try {
    return await response.json();
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}
