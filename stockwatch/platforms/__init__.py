from .zepto import Zepto

PLATFORMS = {"zepto": Zepto}


def get_platform(name, log=print):
    cls = PLATFORMS.get(name.lower())
    return cls(log=log) if cls else None
