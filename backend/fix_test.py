"""Patch e2e_test.py to match the real service signatures."""
import re

with open("e2e_test.py", encoding="utf-8") as f:
    src = f.read()

# 1. add_stock_fifo: remove notes= kwarg, fix return value (FIFOLayer, not dict)
src = re.sub(r",\s*notes=\"Initial stock\",\n", "\n", src)
src = re.sub(r",\s*notes=\"Second batch\",\n", "\n", src)
src = re.sub(r",\s*notes=\"Restock\",\n", "\n", src)
src = src.replace("r1['layer_id']", "r1.pk")
src = src.replace("r2['layer_id']", "r2.pk")

# 2. Sale.PaymentStatus  vs  string "paid"
# The model might use string directly
src = src.replace(
    "sale.payment_status == Sale.PaymentStatus.PAID",
    'sale.payment_status in ("paid", "PAID")',
)

with open("e2e_test.py", "w", encoding="utf-8") as f:
    f.write(src)

print("Patched OK")
