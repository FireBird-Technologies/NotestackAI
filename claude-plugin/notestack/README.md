# Notestack for Claude Code

Notestack turns a writer's published posts (Substack, Ghost, WordPress, Medium, RSS or uploaded files) into a
searchable archive. This plugin connects Claude Code to your Notestack account so you can:

- find your posts, notebooks, topics and sources by name or subject
- ask questions answered only from your own writing, with citations to the exact post and lines
- create study and publishing material from selected posts: quizzes, flashcards, reports, mind maps, infographics,
  slide decks, audio overviews and videos
- import new sources and organise posts into notebooks

## What it installs

One remote MCP server, `https://api.notestack.ai/mcp`, run by Firebird Technologies. The plugin contains no code
of its own: no hooks, scripts or binaries.

## Signing in

The first time Claude Code uses the server it opens Notestack's OAuth sign-in in your browser. You choose which
permissions to grant (read; create and edit; share links). You can see and end the connection at any time in
Notestack under Connectors → Connected apps. You need a Notestack account; some tools use your plan's allowances.

## Data

Requests go only to `api.notestack.ai`. The server reads and changes data in your own Notestack workspace when a
tool asks it to, and questions you ask are saved as chats in your notebooks. Nothing is sent to any other service by
this plugin. See the privacy policy at https://notestack.ai/privacy.

## Install

```
/plugin marketplace add FireBird-Technologies/notestack-claude-plugin
/plugin install notestack@notestack
```

Then run `/mcp` and sign in to Notestack.

## Support

https://notestack.ai/support
