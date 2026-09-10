import argparse
import os

import uvicorn


def main():
    p = argparse.ArgumentParser(prog="coastline-twin-web")
    p.add_argument("--host", default=os.environ.get("COASTLINE_HOST", "127.0.0.1"))
    p.add_argument("--port", type=int, default=int(os.environ.get("COASTLINE_PORT", "8765")))
    p.add_argument("--reload", action="store_true")
    args = p.parse_args()
    uvicorn.run("coastline_twin.web.server:app", host=args.host, port=args.port, reload=args.reload)


if __name__ == "__main__":
    main()
