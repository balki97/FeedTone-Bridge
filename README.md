# FeedTone Bridge for FeedBack

FeedTone Bridge imports complete `.fftone` song packages into FeedBack. It restores every arrangement, tone state, signal chain, and saved mixer value contained in the package. The FeedTone desktop app is not required to import packages.

## Install

1. Open FeedBack's **Plugin Manager**.
2. Paste `https://github.com/balki97/FeedTone-Bridge.git`.
3. Select **Install**, then restart FeedBack.
4. Open **FeedTone** from the plugin navigation.

Future bridge releases can be installed with the Plugin Manager's **Update** button. If an older bundled or manually installed FeedTone Bridge is already listed, remove it first, restart FeedBack, and then install the GitHub version.

Manual installation remains available from the latest GitHub release.

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
