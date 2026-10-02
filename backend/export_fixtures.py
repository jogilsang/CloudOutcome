"""Export versioned synthetic dashboard fixtures; no AWS calls or UI dependency."""
import json
import sys
from pathlib import Path
from domain import dashboard


def fixtures():
    return {f"{service}|{days}|{scenario}": dashboard(service, days, scenario)
            for service in ("checkout", "catalog") for days in (7, 14, 30)
            for scenario in ("baseline", "incident", "empty")}


if __name__ == "__main__":
    Path(sys.argv[1]).write_text(json.dumps(fixtures(), ensure_ascii=False) + "\n")
