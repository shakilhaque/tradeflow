"""
Send a test SMS via the configured gateway and print the RAW provider response.

    python manage.py send_test_sms 01955581021
    python manage.py send_test_sms 01955581021 "Custom message"

Use this to diagnose why a specific number does not receive SMS (e.g. masking
not yet approved, invalid SID, low balance, operator rejection). The output
shows the resolved MSISDN, the SID/URL used, and the full SSL Wireless reply.
"""
import json

from django.core.management.base import BaseCommand

from accounts import sms as sms_mod


class Command(BaseCommand):
    help = "Send a test SMS to a number and print the raw gateway response."

    def add_arguments(self, parser):
        parser.add_argument("phone", help="Recipient mobile (e.g. 01955581021)")
        parser.add_argument("message", nargs="?", default="IFFAA test SMS — checking delivery to this number.")

    def handle(self, *args, **opts):
        phone   = opts["phone"]
        message = opts["message"]

        cfg = sms_mod.get_sms_config()
        self.stdout.write(f"Live backend : {sms_mod.backend_name()}")
        self.stdout.write(f"SID          : {cfg.get('sid')}")
        self.stdout.write(f"URL          : {cfg.get('url')}")
        self.stdout.write(f"Token set    : {'yes' if cfg.get('api_token') else 'NO'}")
        self.stdout.write(f"Enabled      : {cfg.get('enabled')}")
        self.stdout.write("")

        backend = sms_mod.SSLWirelessBackend()
        ok, info = backend.send_verbose(phone, message)

        self.stdout.write(f"Resolved msisdn : {info.get('msisdn')}")
        self.stdout.write(f"csms_id         : {info.get('csms_id')}")
        self.stdout.write("Gateway response:")
        self.stdout.write(json.dumps(info.get("response", info), indent=2, ensure_ascii=False))
        self.stdout.write("")
        if ok:
            self.stdout.write(self.style.SUCCESS("Gateway ACCEPTED the SMS (status SUCCESS)."))
            self.stdout.write("If the phone still gets nothing, it is an operator/masking delivery issue on SSL's side.")
        else:
            self.stdout.write(self.style.ERROR("Gateway REJECTED the SMS — see the response above for the reason."))
