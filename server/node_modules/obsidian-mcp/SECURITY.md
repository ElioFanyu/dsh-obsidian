# Security policy

## Supported versions

The latest 2.x release is supported. Version 1.x is deprecated and contains known path-containment defects.

## Reporting a vulnerability

Do not open a public issue for an undisclosed vulnerability. Use GitHub's private vulnerability reporting feature for this repository and include:

- affected version and platform;
- a minimal reproduction using a disposable vault;
- expected and observed behavior;
- impact and any known mitigations.

Avoid including real vault contents or personal filesystem paths. Maintainers should acknowledge a complete report within seven days and coordinate disclosure after a fix is available.

## Security boundary

An explicit `--vault id=/absolute/path` grants this local process read/write access to that root. MCP tool paths must remain within it. The server does not authenticate local stdio clients; the launching MCP host controls who can invoke the process and which vault arguments it receives.
