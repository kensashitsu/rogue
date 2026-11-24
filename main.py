# エントリポイント
import asyncio
import datetime
import os
import sys
import traceback
from game import run_game
from i18n import tr

_HERE      = os.path.dirname(os.path.abspath(__file__))
_ERROR_LOG = os.path.join(_HERE, 'error.log')


if __name__ == "__main__":
    try:
        asyncio.run(run_game())   # キー入力を待つ流れは async（ブラウザ版で止まらずに待つため。2026-11-24）
    except RuntimeError as e:
        sys.stderr.write(tr("Error: {e}", e=e) + "\n")
        sys.exit(1)
    except (KeyboardInterrupt, SystemExit):
        raise
    except Exception:
        try:
            now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            with open(_ERROR_LOG, 'w', encoding='utf-8') as f:
                f.write(f"=== CRASH REPORT ===\n")
                f.write(f"Date: {now}\n\n")
                f.write(traceback.format_exc())
        except OSError:
            pass
        raise
