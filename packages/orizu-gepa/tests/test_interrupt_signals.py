"""ORI-2402: stop signals become a catchable interrupt while a local run is live."""

from __future__ import annotations

import os
import signal
import unittest

from orizu_gepa_connector.runtime import RunInterrupted, interrupt_signals


class InterruptSignalsTest(unittest.TestCase):
    def test_stop_signals_raise_run_interrupted_while_installed(self):
        for name in ("SIGTERM", "SIGHUP", "SIGQUIT"):
            with self.subTest(signal=name):
                with self.assertRaises(RunInterrupted) as raised:
                    with interrupt_signals():
                        # Python runs the handler before the next bytecode.
                        os.kill(os.getpid(), getattr(signal, name))
                        self.fail("the signal did not interrupt the run")
                self.assertEqual(raised.exception.signal_name, name)

    def test_previous_handlers_come_back_afterwards(self):
        """Kills leaving the run's handlers installed after the run ends."""
        before = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT, signal.SIGQUIT)}
        with interrupt_signals():
            pass
        self.assertEqual({sig: signal.getsignal(sig) for sig in before}, before)


if __name__ == "__main__":
    unittest.main()
