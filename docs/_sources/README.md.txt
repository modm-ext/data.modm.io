# Documentation

modm-data is documented in three ways as a public homepage:

1. The Markdown files in this folder describe high-level concepts.
2. The auto-generated Python API describes the low-level usage.
3. The auto-generated Knowledge Graph API describes the end-user experience.

You need to install Sphinx and a few plugins:

```sh
pip3 install -r docs/requirements.txt
```

Then you can build the homepage locally:

```sh
make build-docs
```

