import os
import sys
from pathlib import Path

# Must be set before deepeval is imported anywhere.
os.environ.setdefault("DEEPEVAL_TELEMETRY_OPT_OUT", "YES")
# .env.example ships blank OPENAI_* lines; the agent treats blanks as unset, but the
# OpenAI client would use e.g. OPENAI_BASE_URL="" as a real (broken) URL.
for _name in [k for k, v in os.environ.items() if k.startswith("OPENAI_") and not v.strip()]:
    del os.environ[_name]
sys.path.insert(0, str(Path(__file__).parent))

import pytest  # noqa: E402

from runs_loader import RUNS_DIR, load_meta, load_runs  # noqa: E402


def pytest_collection_modifyitems(config, items):
    if items and not load_runs():
        raise pytest.UsageError(f"No runs in {RUNS_DIR}. Run `npm run eval:export` first.")


def pytest_report_header(config):
    meta = load_meta()
    judge = "on" if os.environ.get("OPENAI_API_KEY") else "off (set OPENAI_API_KEY to enable)"
    return f"disputo evals: {meta.get('cases', 0)} runs, llm={meta.get('llm', '?')}, LLM judge {judge}"
