# Demo Platform user guide

## Install

Clone the repository, install dependencies, and copy the example env file.
The typed config loader fails fast on missing variables.

## First run

Start the API and the admin console, then open the console in a browser.
The notes list renders from the seeded store on first launch.

## Operations

Structured json logs land on stdout; every handler failure uses the shared
error envelope so clients receive one predictable shape.
