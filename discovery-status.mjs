// Discovery never proves date, active application, language eligibility or publication.
export function discoveryOutcome(blockers, findings) {
  return {
    status: blockers.length && !findings.length ? 'blocked' : 'awaiting_verification',
    outcome: 'partial',
    verificationComplete: false,
    publicationComplete: false
  };
}
