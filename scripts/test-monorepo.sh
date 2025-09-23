#!/bin/bash

# let's use the repo's alchemy version (but we can't use workspace:* so must use link)
cd alchemy 
bun link 
# install deps and tsc -b
cd ../example-monorepo 
bun i 
bun run build
# deploy backend and then frontend
bun run deploy 
# destroy frontend and then backend
bun run destroy 
# second destroy is to ensure that it still works even if `backend` has already been destroyed
bun run destroy