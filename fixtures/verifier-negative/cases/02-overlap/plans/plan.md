# Serialization plan (poisoned: two same-wave tasks own one file)

OW1 rewrites the format while OW2 adds compression on top; both edit the same
file in the same wave, which parallel workers would corrupt.
