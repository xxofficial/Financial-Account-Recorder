import argparse
import sys
import subprocess


def install_pyinstaller():
    try:
        import PyInstaller  # noqa: F401
    except ImportError:
        print("PyInstaller 未安装，正在自动安装...")
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", "--upgrade", "pyinstaller", "pyinstaller-hooks-contrib"]
        )


def build(debug: bool, onedir: bool) -> None:
    install_pyinstaller()

    args = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--name",
        "recoder-market-fetcher",
        # PyQt6 相关
        "--hidden-import",
        "PyQt6.sip",
        "--collect-all",
        "PyQt6",
        # 数据源依赖（确保子依赖也被打入）
        "--hidden-import",
        "yfinance",
        "--hidden-import",
        "akshare",
        "--hidden-import",
        "requests",
        "--hidden-import",
        "pandas",
        "--hidden-import",
        "lxml",
        "--hidden-import",
        "html5lib",
        "--hidden-import",
        "appdirs",
        "--collect-all",
        "yfinance",
        "--collect-all",
        "akshare",
        "--collect-all",
        "pandas",
        "main.py",
    ]

    if not debug:
        args.append("--windowed")
    if onedir:
        args.append("--onedir")
    else:
        args.append("--onefile")

    print("运行 PyInstaller...")
    subprocess.check_call(args)
    print("打包完成，输出目录：dist/")
    if not onedir:
        print("提示：单文件 exe 启动时会把所有文件解压到临时目录，首次启动可能较慢。")


def main():
    parser = argparse.ArgumentParser(description="打包 Recoder 行情预取工具")
    parser.add_argument(
        "--debug", action="store_true", help="保留控制台窗口，方便查看错误信息"
    )
    parser.add_argument(
        "--onedir", action="store_true", help="输出为目录而非单文件，兼容性更好"
    )
    args = parser.parse_args()
    build(debug=args.debug, onedir=args.onedir)


if __name__ == "__main__":
    main()
