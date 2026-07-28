# FeedTone Bridge for FeedBack

FeedTone Bridge imports complete `.fftone` song packages into FeedBack. It restores every arrangement, tone state, signal chain, and saved mixer value contained in the package. The FeedTone desktop app is not required to import packages.

## Install

1. Download `FeedTone-Bridge.zip` from the latest release.
2. Close FeedBack.
3. Extract the `feedtone_bridge` folder to `%APPDATA%\feedback-desktop\plugins\`.
4. Restart FeedBack and open **FeedTone** from the plugin navigation.

## Import a tone

1. Open the matching song in FeedBack.
2. Open the **FeedTone** plugin.
3. Select **Import .fftone** and choose the downloaded package.
4. Select an arrangement or enable **Follow song timeline**.

The package must target the song currently open in FeedBack. `.fftone` files contain tone settings and optional portable NAM/IR assets; they do not contain song audio, charts, stems, PSARC, or FeedPak files.

## Contents

The distributable plugin is the `feedtone_bridge` folder containing `plugin.json`, `routes.py`, `screen.html`, and `screen.js`.
