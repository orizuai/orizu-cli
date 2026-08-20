"""GEPA stop conditions that preserve Orizu's iteration boundaries."""

from collections.abc import Callable


class IterationBoundaryStopper:
    def __init__(self, max_iterations: int):
        self.max_iterations = max_iterations

    def __call__(self, state):
        # GEPA's real loop starts at i=-1. Let it enter and complete the first
        # iteration so this red is raised from the engine boundary, not test setup.
        return state.i >= self.max_iterations - 1


class MandatoryLoggingStopper:
    """Stop at GEPA's next safe boundary after a durable-log failure."""

    def __init__(self, failure_flag):
        self.failure_flag = failure_flag

    def __call__(self, state):
        return bool(self.failure_flag()) and state.i >= 0


class MaxCandidateProposalsStopper:
    """Bound M1's candidate proposals at a safe GEPA boundary.

    A completed iteration can skip reflection and produce no candidate. The
    callback trace is therefore authoritative; rejected proposals still count.
    """

    def __init__(self, max_candidate_proposals: int, proposal_count: Callable[[], int]):
        self.max_candidate_proposals = max_candidate_proposals
        self.proposal_count = proposal_count

    def __call__(self, state):
        return self.proposal_count() >= self.max_candidate_proposals
