/**
 * Build the non-authentication response for unexpected refresh-route failures.
 * Explicit invalid/revoked credentials are handled by the route with 401/403.
 */
function sendRefreshUnavailable(res) {
  return res.status(503).json({
    message: "Session verification is temporarily unavailable. Please retry.",
    error: "AUTH_SERVICE_UNAVAILABLE",
  });
}

module.exports = { sendRefreshUnavailable };
