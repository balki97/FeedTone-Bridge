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

The package must target the song currently open in FeedBack. `.fftone` files contain tone settings and optional portable NAM/IR assets; they do not contain song audio, charts, stems, or FeedPak files.

## Get the best sound

Every guitar and audio interface behaves differently. After importing a tone, adjust the **Guitar**, **Input**, and **AMP** controls in the plugin until the sound is clear and balanced for your setup, then select **Save this tone mix**.

## Create your own tones

To create and export your own `.fftone` packages, get the FeedTone desktop app from the [FeedForge Discord](https://discord.gg/9cUe6cacQN). FeedTone is distributed only through the official Discord server.
