# AI BASE - Monthly Meetup Summaries

A lightweight website for AI BASE meetup event summaries, hosted on GitHub Pages.

## About AI BASE

AI BASEは、AI関連のニュースや情報を共有し、月次で振り返るミートアップです。Discordチャンネルで日々情報を共有し、月に一度集まってレビューしています。

## Setup GitHub Pages

1. Push this repository to GitHub
2. Go to repository Settings > Pages
3. Under "Source", select "Deploy from a branch"
4. Select "main" branch and "/ (root)" folder
5. Click Save

Your site will be available at: `https://[username].github.io/[repository-name]/`

## Structure

```
.
├── index.html          # Landing page
├── style.css          # Stylesheet
├── summaries/         # Monthly summary pages
│   └── 2025-12.html  # December 2025 summary
└── README.md         # This file
```

## Adding New Monthly Summaries

1. Create a new HTML file in the `summaries/` folder (e.g., `2025-11.html`)
2. Copy the structure from `summaries/2025-12.html`
3. Update the content with new links and information
4. Add a new summary card to `index.html` in the `.summary-list` section

## License

Copyright 2025 AI BASE. All rights reserved.
